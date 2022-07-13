// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "../interfaces/VotingV2Interface.sol";

import "hardhat/console.sol";

/**
 * @title Library to compute rounds and phases for an equal length commit-reveal voting cycle.
 */
library VoteTimingV2 {
    using SafeMath for uint256;

    struct Data {
        uint256 phaseLength;
        uint256 minRollToNextRoundLength;
    }

    /**
     * @notice Initializes the data object. Sets the phase length based on the input.
     */
    function init(
        Data storage data,
        uint256 phaseLength,
        uint256 minRollToNextRoundLength
    ) internal {
        // This should have a require message but this results in an internal Solidity error.
        require(phaseLength > 0);
        require(minRollToNextRoundLength <= phaseLength);
        data.phaseLength = phaseLength;
        data.minRollToNextRoundLength = minRollToNextRoundLength;
    }

    /**
     * @notice Computes the roundID based off the current time as floor(timestamp/roundLength).
     * @dev The round ID depends on the global timestamp but not on the lifetime of the system.
     * The consequence is that the initial round ID starts at an arbitrary number (that increments, as expected, for subsequent rounds) instead of zero or one.
     * @param data input data object.
     * @param currentTime input unix timestamp used to compute the current roundId.
     * @return roundId defined as a function of the currentTime and `phaseLength` from `data`.
     */
    function computeCurrentRoundId(Data storage data, uint256 currentTime) internal view returns (uint256) {
        uint256 roundLength = data.phaseLength.mul(uint256(VotingV2Interface.Phase.NUM_PHASES_PLACEHOLDER));
        return currentTime.div(roundLength);
    }

    /**
     * @notice compute the round end time as a function of the round Id.
     * @param data input data object.
     * @param roundId uniquely identifies the current round.
     * @return timestamp unix time of when the current round will end.
     */
    function computeRoundEndTime(Data storage data, uint256 roundId) internal view returns (uint256) {
        uint256 roundLength = data.phaseLength.mul(uint256(VotingV2Interface.Phase.NUM_PHASES_PLACEHOLDER));
        return roundLength.mul(roundId.add(1));
    }

    /**
     * @notice Computes the current phase based only on the current time.
     * @param data input data object.
     * @param currentTime input unix timestamp used to compute the current roundId.
     * @return current voting phase based on current time and vote phases configuration.
     */
    function computeCurrentPhase(Data storage data, uint256 currentTime)
        internal
        view
        returns (VotingV2Interface.Phase)
    {
        // This employs some hacky casting. We could make this an if-statement if we're worried about type safety.
        return
            VotingV2Interface.Phase(
                currentTime.div(data.phaseLength).mod(uint256(VotingV2Interface.Phase.NUM_PHASES_PLACEHOLDER))
            );
    }

    function computeRoundToVoteOnPriceRequest(Data storage data, uint256 currentTime) internal view returns (uint256) {
        uint256 currentRoundId = computeCurrentRoundId(data, currentTime);
        uint256 roundEndTime = computeRoundEndTime(data, currentRoundId);
        if (currentTime >= roundEndTime - data.minRollToNextRoundLength) return currentRoundId.add(2);
        else return currentRoundId.add(1);
    }
}