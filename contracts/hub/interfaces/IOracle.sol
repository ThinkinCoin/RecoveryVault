// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

/// @notice Oracle interface for USD/ONE price feed
interface IOracle {
    /// @return price USD per ONE (ex: 0.0123 * 1e8 = 1230000)
    /// @return decimals Number of decimal places for price (ex: 8)
    function latestPrice() external view returns (int256 price, uint8 decimals);
}
