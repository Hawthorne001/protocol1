const hre = require("hardhat");
const { web3 } = hre;
const { runDefaultFixture, didContractThrow } = require("@uma/common");
const { getContract } = hre;

const { assert } = require("chai");
const { toBN } = web3.utils;

const StakerSnapshotTest = getContract("StakerSnapshotTest");
const VotingToken = getContract("VotingToken");
const Timer = getContract("Timer");

const toWei = (value) => toBN(web3.utils.toWei(value, "ether"));

const emissionRate = "640000000000000000"; // Approximately 20% APY with a total supply of 100mm tokens.
const unstakeCoolDown = 60 * 60 * 30; // 1 month.

const amountToStake = toWei("1000");

describe("StakerSnapshot", function () {
  let staker, votingToken, timer, accounts, account1, account2, account3;

  const advanceTime = async (time) => {
    await staker.methods
      .setCurrentTime(Number(await staker.methods.getCurrentTime().call()) + time)
      .send({ from: account1 });
  };

  beforeEach(async function () {
    accounts = await web3.eth.getAccounts();
    [account1, account2, account3] = accounts;
    await runDefaultFixture(hre);
    votingToken = await VotingToken.deployed();
    timer = await Timer.deployed();

    staker = await StakerSnapshotTest.new(
      emissionRate,
      unstakeCoolDown,
      votingToken.options.address,
      timer.options.address
    ).send({
      from: account1,
    });

    // Allow account1 to mint tokens.
    const minterRole = 1;
    await votingToken.methods.addMember(minterRole, account1).send({ from: account1 });
    await votingToken.methods.addMember(minterRole, staker.options.address).send({ from: account1 });

    // Account1 starts with 100MM tokens. Send 32mm to the other three accounts.
    await votingToken.methods.approve(staker.options.address, toWei("32000000")).send({ from: account1 });
    await votingToken.methods.transfer(account2, toWei("32000000")).send({ from: account1 });
    await votingToken.methods.approve(staker.options.address, toWei("32000000")).send({ from: account2 });
    await votingToken.methods.transfer(account3, toWei("32000000")).send({ from: account1 });
    await votingToken.methods.approve(staker.options.address, toWei("32000000")).send({ from: account3 });
  });
  describe("Staking: rewards accumulation", function () {
    it("Staking accumulates prorata rewards over time", async function () {
      await staker.methods.stake(amountToStake).send({ from: account1 });
      const stakingBalance = await staker.methods.voterStakes(account1).call();
      assert.equal(stakingBalance.cumulativeStaked, amountToStake);

      // Advance time forward 1000 seconds. At an emission rate of 0.64 per second we should see the accumulation of
      // all rewards equal to the amount staked * 1000 * 0.64 = 640.
      await advanceTime(1000);
      assert.equal(await staker.methods.outstandingRewards(account1).call(), toWei("640"));

      // Claim the rewards and ensure balances update accordingly.
      const balanceBefore = await votingToken.methods.balanceOf(account1).call();
      await staker.methods.withdrawRewards().send({ from: account1 });
      assert.equal(
        await votingToken.methods.balanceOf(account1).call(),
        toWei("640").add(toBN(balanceBefore)).toString()
      );

      // Now have account2 stake 3x the amount of account1. Ensure a prorata split of future rewards as 1/4 3/4ths.
      await staker.methods.stake(amountToStake.muln(3)).send({ from: account2 });

      // Advance time forward 1000 seconds. At an emission rate of 0.64 per second we should see the accumulation of
      // 1/4*640=160 to account1 and 2/3*640=480 to account2.
      await advanceTime(1000);
      assert.equal(await staker.methods.outstandingRewards(account1).call(), toWei("160"));
      assert.equal(await staker.methods.outstandingRewards(account2).call(), toWei("480"));

      // Next, stake 2x the original amount of tokens from another account. This should result in a prorata split of
      // rewards with account1 staking 1/6th, account2 staking 3/6 and account3 staking 2/6. Subsequent rewards should
      // correctly factor in the 160 & 480 rewards split between account1 and account2 that have not yet been claimed.
      // This shows the correct "memory" of the staking system with subsequent stakes.
      await staker.methods.stake(amountToStake.muln(2)).send({ from: account3 });

      // Over 1500 seconds we should emit a total of 1500 * 0.64 = 960 rewards.
      //    Account1: 160 + 1/6 * 960 = 320
      //    Account2: 480 + 3/6 * 960 = 960
      //    Account3: 0   + 2/6 * 960 = 320
      await advanceTime(1500);
      assert.equal(await staker.methods.outstandingRewards(account1).call(), toWei("320"));
      assert.equal(await staker.methods.outstandingRewards(account2).call(), toWei("960"));
      assert.equal(await staker.methods.outstandingRewards(account3).call(), toWei("320"));
    });
    it("Blocks bad unstake attempt", async function () {
      await staker.methods.stake(amountToStake).send({ from: account1 });

      // Try to request to unstake more than staked amount.
      assert(await didContractThrow(staker.methods.requestUnstake(amountToStake.addn(1)).send({ from: account1 })));
    });
    it("Unstaking is correctly blocked for unlock time", async function () {
      await staker.methods.stake(amountToStake).send({ from: account1 });

      // Attempting to unstake without requesting.
      assert(await didContractThrow(staker.methods.executeUnstake().send({ from: account1 })));
      await staker.methods.requestUnstake(amountToStake).send({ from: account1 });
      // Not waiting long enough should also revert.
      assert(await didContractThrow(staker.methods.executeUnstake().send({ from: account1 })));
      await advanceTime(1000);
      assert(await didContractThrow(staker.methods.executeUnstake().send({ from: account1 })));

      // Now advance the 1 month required to unstake.
      await advanceTime(60 * 60 * 24 * 30);
      const balanceBefore = await votingToken.methods.balanceOf(account1).call();
      await staker.methods.executeUnstake().send({ from: account1 });
      const balanceAfter = await votingToken.methods.balanceOf(account1).call();
      assert.equal(balanceAfter, amountToStake.add(toBN(balanceBefore))); // Should get back the original amount staked.

      // Accumulated rewards over the interval should be the full 0.64 percent, grown over 30 days + 1000 seconds.
      // This should be 0.64 * (60 * 60 * 24 * 30 + 1000) = 1659520.
      assert.equal(await staker.methods.outstandingRewards(account1).call(), toWei("1659520"));
      await staker.methods.withdrawRewards().send({ from: account1 });
      assert.equal(await votingToken.methods.balanceOf(account1).call(), toBN(balanceAfter).add(toWei("1659520")));

      // No further rewards should accumulate to the staker as they have claimed and unstked the full amount.
      assert.equal(await staker.methods.outstandingRewards(account1).call(), toWei("0"));
      await advanceTime(1000);
      assert.equal(await staker.methods.outstandingRewards(account1).call(), toWei("0"));
    });
    it("Re-requesting to unstake resets the timer", async function () {
      await staker.methods.stake(amountToStake).send({ from: account1 });

      const requestTime = Number(await staker.methods.getCurrentTime().call());
      await staker.methods.requestUnstake(amountToStake).send({ from: account1 });
      assert((await staker.methods.voterStakes(account1).call()).unstakeTime, requestTime + unstakeCoolDown);
      assert((await staker.methods.voterStakes(account1).call()).requestUnstake, amountToStake);

      // User can re-request to unstake with a new amount. This should set the request amount to the new amount and
      // reset the unlock timer forward again.
      await advanceTime(1000);
      await staker.methods.requestUnstake(amountToStake.divn(2)).send({ from: account1 });
      assert((await staker.methods.voterStakes(account1).call()).unstakeTime, requestTime + unstakeCoolDown + 1000);
      assert((await staker.methods.voterStakes(account1).call()).requestUnstake, amountToStake.divn(2));

      assert(await didContractThrow(staker.methods.executeUnstake().send({ from: account1 })));

      // Now advance the 1 month required to unstake.
      await advanceTime(60 * 60 * 24 * 30);
      const balanceBefore = await votingToken.methods.balanceOf(account1).call();
      await staker.methods.executeUnstake().send({ from: account1 });
      const balanceAfter = await votingToken.methods.balanceOf(account1).call();
      assert.equal(balanceAfter, amountToStake.divn(2).add(toBN(balanceBefore))); // Should get back the original amount staked.

      // Accumulated rewards over the interval should be the full 0.64 percent, grown over 30 days + 1000 seconds.
      // This should be 0.64 * (60 * 60 * 24 * 30 + 1000) = 1659520.
      assert.equal(await staker.methods.outstandingRewards(account1).call(), toWei("1659520"));
      await staker.methods.withdrawRewards().send({ from: account1 });
      assert.equal(await votingToken.methods.balanceOf(account1).call(), toBN(balanceAfter).add(toWei("1659520")));
    });

    it("Emission rate updates shouldn't be retroactive", async function () {
      await staker.methods.stake(amountToStake).send({ from: account1 }); // stake 1/4th
      await staker.methods.stake(amountToStake.muln(3)).send({ from: account2 }); // stake 3/4ths
      await advanceTime(1000);

      const account1Rewards = await staker.methods.outstandingRewards(account1).call();
      const account2Rewards = await staker.methods.outstandingRewards(account2).call();

      assert.equal(account1Rewards, toWei("160")); // 1000 * 0.64 * 1/4 = 160
      assert.equal(account2Rewards, toWei("480")); // 1000 * 0.64 * 3/4 = 480

      // Now change the emission rate: initialEmissionRate * 3
      const oldEmissionRate = await staker.methods.emissionRate().call();
      await staker.methods.setEmissionRate(toBN(oldEmissionRate).muln(3)).send({ from: account1 });

      // Unclaimed rewards should keep the same
      assert.equal(await staker.methods.outstandingRewards(account1).call(), account1Rewards);
      assert.equal(await staker.methods.outstandingRewards(account2).call(), account2Rewards);

      // New emission rate should be applied to NEW rewards.
      await advanceTime(1000);
      assert.equal(await staker.methods.outstandingRewards(account1).call(), toWei("160").add(toWei("480"))); // 160 + 1000 * 0.64 * 3 * 1/4  = 480
      assert.equal(await staker.methods.outstandingRewards(account2).call(), toWei("480").add(toWei("1440"))); // 480 + 1000 * 0.64 * 3 * 3/4 = 1440
    });
  });
  describe("Slashing: unrealizedSlash consideration", function () {
    it("Applied slashing correctly impacts staked users future rewards", async function () {
      // Stake some amount, advance time and check that there is an unclaimed reward.
      await staker.methods.stake(amountToStake).send({ from: account1 }); // stake 1/4th
      await staker.methods.stake(amountToStake.muln(3)).send({ from: account2 }); // stake 3/4ths
      await advanceTime(1000);
      assert.equal(await staker.methods.outstandingRewards(account1).call(), toWei("160")); // 1000 * 0.64 * 1/4 = 160
      assert.equal(await staker.methods.outstandingRewards(account2).call(), toWei("480")); // 1000 * 0.64 * 3/4 = 480

      // Now assume that voter2 votes wrong. Assume for the case of this test the slashing amount is 200 Wei. This should
      // not impact any of their claimable rewards but it should impact their cumlativeStaked and therefore impact their
      // share of rewards going forward. Note that here we are ignoring how slashing is computed. This just assumes that
      // the slashing amount flows totally from account1 to account2.
      await staker.methods.applySlashingToCumulativeStaked(account1, toWei("200")).send({ from: account1 });
      await staker.methods.applySlashingToCumulativeStaked(account2, toWei("-200")).send({ from: account1 });
      // Cumulative staked should have been shifted accordingly.
      assert.equal((await staker.methods.voterStakes(account1).call()).cumulativeStaked, toWei("1200"));
      assert.equal((await staker.methods.voterStakes(account2).call()).cumulativeStaked, toWei("2800"));

      // Outstanding rewards should be the same as before (not effected by slashing)
      assert.equal(await staker.methods.outstandingRewards(account1).call(), toWei("160")); // 160
      assert.equal(await staker.methods.outstandingRewards(account2).call(), toWei("480")); // 480

      // Now, accumulate more rewards. Check that accumulation behaves as expected. Advance time forward another 1500
      // seconds. Now we should accumulate a total of 0.64 * 1500 = 960 rewards. This should now be split between the
      // two accounts with account1 getting 1200/4000 * 960 = 288 and account2 getting 2800/4000 * 960 = 672.
      await advanceTime(1500);
      assert.equal(await staker.methods.outstandingRewards(account1).call(), toWei("448")); // 160 + 288 = 448

      assert.equal(await staker.methods.outstandingRewards(account2).call(), toWei("1152")); // 480  + 672 = 1152

      // Now, claim the rewards. Check that the claims are correctly attributed to the correct accounts.
      const account1BalBefore = await votingToken.methods.balanceOf(account1).call();
      const account2BalBefore = await votingToken.methods.balanceOf(account2).call();
      await staker.methods.withdrawRewards().send({ from: account1 });
      await staker.methods.withdrawRewards().send({ from: account2 });
      assert.equal(await votingToken.methods.balanceOf(account1).call(), toBN(account1BalBefore).add(toWei("448")));
      assert.equal(await votingToken.methods.balanceOf(account2).call(), toBN(account2BalBefore).add(toWei("1152")));
    });

    it("Slashing a users whole balance totally attenuates their rewards over time", async function () {
      await staker.methods.stake(amountToStake).send({ from: account1 }); // stake 1/4th
      await staker.methods.stake(amountToStake.muln(3)).send({ from: account2 }); // stake 3/4ths
      await advanceTime(1000);
      assert.equal(await staker.methods.outstandingRewards(account1).call(), toWei("160")); // 1000 * 0.64 * 1/4 = 160
      assert.equal(await staker.methods.outstandingRewards(account2).call(), toWei("480")); // 1000 * 0.64 * 3/4 = 480

      // Now slash half the balance of account1.
      await staker.methods.applySlashingToCumulativeStaked(account1, amountToStake.divn(-2)).send({ from: account1 });
      await staker.methods.applySlashingToCumulativeStaked(account2, amountToStake.divn(2)).send({ from: account1 });

      // Now advance another 1000 seconds. This will accrue another 640 rewards. Now, though, the allocation will be
      // 500/4000 * 640 = 80 to account1 and 3500/4000 * 640 = 560 to account2.
      await advanceTime(1000);
      assert.equal(await staker.methods.outstandingRewards(account1).call(), toWei("240")); // 160 + 80 = 240
      assert.equal(await staker.methods.outstandingRewards(account2).call(), toWei("1040")); // 480 + 560 = 1040

      // Slash the remaining account1's balance. They should accumulate no more rewards and everyhing goes to account2.
      await staker.methods.applySlashingToCumulativeStaked(account1, amountToStake.divn(-2)).send({ from: account1 });
      await staker.methods.applySlashingToCumulativeStaked(account2, amountToStake.divn(2)).send({ from: account1 });

      await advanceTime(1000);
      assert.equal(await staker.methods.outstandingRewards(account1).call(), toWei("240")); // 240 + 0 = 240
      assert.equal(await staker.methods.outstandingRewards(account2).call(), toWei("1680")); // 1040 + 640 = 1680
    });
  });

  describe("Snapshotting: Correctly snapshots staked and unrealized slashing amounts", function () {
    it("Snapshot correctly captures staked balances at stake  and unstake time", async function () {
      await staker.methods.stake(amountToStake).send({ from: account1 }); // stake 1/4th
      await staker.methods.stake(amountToStake.muln(3)).send({ from: account2 }); // stake 3/4ths

      // Capture the snapshot and validate the snapshot balances.
      await staker.methods.snapshot().send({ from: account1 });
      assert.equal(await staker.methods.stakedAt(account1, 1).call(), amountToStake);
      assert.equal(await staker.methods.stakedAt(account2, 1).call(), amountToStake.muln(3));
      assert.equal(await staker.methods.totalStakedAt(1).call(), amountToStake.muln(4));

      // // Modify the balances. Should not update historic snapshots.
      await staker.methods.stake(amountToStake).send({ from: account1 });
      assert.equal(await staker.methods.stakedAt(account1, 1).call(), amountToStake);
      assert.equal(await staker.methods.stakedAt(account2, 1).call(), amountToStake.muln(3));
      assert.equal(await staker.methods.totalStakedAt(1).call(), amountToStake.muln(4));

      await staker.methods.stake(amountToStake.muln(2)).send({ from: account2 });
      assert.equal(await staker.methods.stakedAt(account1, 1).call(), amountToStake);
      assert.equal(await staker.methods.stakedAt(account2, 1).call(), amountToStake.muln(3));
      assert.equal(await staker.methods.totalStakedAt(1).call(), amountToStake.muln(4));

      // Now snapshot again. Should get the most recent changes.
      await staker.methods.snapshot().send({ from: account1 });
      assert.equal(await staker.methods.stakedAt(account1, 2).call(), amountToStake.muln(2));
      assert.equal(await staker.methods.stakedAt(account2, 2).call(), amountToStake.muln(5));
      assert.equal(await staker.methods.totalStakedAt(2).call(), amountToStake.muln(7));

      // now unstake from account2.
      await staker.methods.requestUnstake(amountToStake.muln(5)).send({ from: account2 });

      await advanceTime(60 * 60 * 24 * 30 + 1);
      await staker.methods.executeUnstake().send({ from: account2 });

      // Previous snapshot should still be the same.
      assert.equal(await staker.methods.stakedAt(account1, 2).call(), amountToStake.muln(2));
      assert.equal(await staker.methods.stakedAt(account2, 2).call(), amountToStake.muln(5));
      assert.equal(await staker.methods.totalStakedAt(2).call(), amountToStake.muln(7));

      // New snapshot should reflect the most recent balances.
      await staker.methods.snapshot().send({ from: account1 });
      assert.equal(await staker.methods.stakedAt(account1, 3).call(), amountToStake.muln(2));
      assert.equal(await staker.methods.stakedAt(account2, 3).call(), toBN(0));
      assert.equal(await staker.methods.totalStakedAt(3).call(), amountToStake.muln(2));
    });
  });
});