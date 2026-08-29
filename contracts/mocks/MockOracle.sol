// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import "../hub/interfaces/IOracle.sol"; // ou defina a interface aqui

contract MockOracle is IOracle {
    int256 private _price;
    uint8 private _decimals;

    constructor(int256 initialPrice, uint8 initialDecimals) {
        _price = initialPrice;
        _decimals = initialDecimals;
    }

    function setPrice(int256 newPrice) external {
        _price = newPrice;
    }

    function setDecimals(uint8 newDecimals) external {
        _decimals = newDecimals;
    }

    function latestPrice() external view override returns (int256 price, uint8 decimals) {
        return (_price, _decimals);
    }
}
