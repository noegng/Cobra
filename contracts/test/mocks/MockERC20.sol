// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Plain test ERC-20 with public mint. `noReturn = true` mimics USDT-on-Ethereum style tokens whose
///         transfer/transferFrom/approve return no data.
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    bool public noReturn;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    function setNoReturn(bool v) external {
        noReturn = v;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external virtual returns (bool) {
        if (returnFalse) return false;
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return _ok();
    }

    function transfer(address to, uint256 amount) external virtual returns (bool) {
        if (returnFalse) return false;
        _transfer(msg.sender, to, amount);
        return _ok();
    }

    function transferFrom(address from, address to, uint256 amount) external virtual returns (bool) {
        if (returnFalse) return false;
        _spendAllowance(from, msg.sender, amount);
        _transfer(from, to, amount);
        return _ok();
    }

    function _spendAllowance(address from, address spender, uint256 amount) internal {
        uint256 a = allowance[from][spender];
        if (a != type(uint256).max) {
            require(a >= amount, "ERC20: allowance");
            allowance[from][spender] = a - amount;
        }
    }

    function _transfer(address from, address to, uint256 amount) internal virtual {
        require(to != address(0), "ERC20: to zero");
        require(balanceOf[from] >= amount, "ERC20: balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    /// @notice When set, transfer/transferFrom/approve do nothing and return false (old-style failure signalling).
    bool public returnFalse;

    function setReturnFalse(bool v) external {
        returnFalse = v;
    }

    function _ok() internal view returns (bool) {
        if (noReturn) {
            assembly {
                return(0, 0)
            }
        }
        return true;
    }
}
