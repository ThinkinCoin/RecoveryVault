// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

interface IOracle {
    function latestPrice() external view returns (int256 price, uint8 decimals);
}

interface IBandRef {
    function getReferenceData(string calldata base, string calldata quote)
        external
        view
        returns (uint256 rate, uint256 lastUpdatedBase, uint256 lastUpdatedQuote);
}

contract BandAdapter is IOracle {
    IBandRef public immutable band;
    string public constant BASE = "ONE";
    string public constant QUOTE = "USD";

    constructor(address bandRefAddress) {
        require(bandRefAddress != address(0), "invalid band address");
        band = IBandRef(bandRefAddress);
    }

    function latestPrice() external view returns (int256 price, uint8 decimals) {
        (uint256 rate,,) = band.getReferenceData(BASE, QUOTE);
        require(rate > 0, "Band: invalid rate");
        return (int256(rate), 18);
    }
}
