// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/*
 * LevSupplyHelper — DELEGATECALLed by the position Safe (so address(this) == the Safe) inside an
 * INCREASE post step. It supplies the Safe's ENTIRE collateral balance to Aave (not just the signed
 * minBuy), so positive swap slippage is not left idle (codex medium finding). Stateless; the Safe's
 * storage is never written (only external calls), so it is safe to delegatecall.
 */
interface IERC20S { function balanceOf(address) external view returns (uint256); function approve(address,uint256) external returns (bool); }
interface IAaveSupply {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function getUserAccountData(address) external view returns (uint256,uint256,uint256,uint256,uint256,uint256);
}

contract LevSupplyHelper {
    function supplyAll(address token, address pool) external {
        uint256 amt = IERC20S(token).balanceOf(address(this));
        require(amt > 0, "nothing to supply");
        IERC20S(token).approve(pool, amt);
        IAaveSupply(pool).supply(token, amt, address(this), 0);
    }

    /// DELEGATECALLed by the Safe as the INCREASE `post`: supply the full bought collateral, then
    /// enforce the signed minHealthFactor (HF read for address(this) == the Safe). One call, no MultiSend.
    function supplyAllAndCheck(address token, address pool, uint256 minHF) external {
        uint256 amt = IERC20S(token).balanceOf(address(this));
        require(amt > 0, "nothing to supply");
        IERC20S(token).approve(pool, amt);
        IAaveSupply(pool).supply(token, amt, address(this), 0);
        if (minHF != 0) {
            (,,,,, uint256 hf) = IAaveSupply(pool).getUserAccountData(address(this));
            require(hf >= minHF, "HF too low");
        }
    }
}
