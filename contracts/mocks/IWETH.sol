// contracts/mocks/IWETHMock.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {ERC20} from "../hub/token/ERC20/ERC20.sol";

contract IWETHMock is ERC20 {
    constructor() ERC20("Wrapped ONE", "wONE") {}

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        _mint(msg.sender, msg.value);
    }
}
