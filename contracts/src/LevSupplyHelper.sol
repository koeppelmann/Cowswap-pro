// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/*
 * LevSupplyHelper — DELEGATECALLed by the position Safe (so address(this) == the Safe) inside an
 * INCREASE post step. It supplies the Safe's ENTIRE collateral balance to Aave (not just the signed
 * minBuy), so positive swap slippage is not left idle (codex medium finding). Stateless; the Safe's
 * storage is never written (only external calls), so it is safe to delegatecall.
 */
interface IERC20S { function balanceOf(address) external view returns (uint256); function approve(address,uint256) external returns (bool); function transfer(address,uint256) external returns (bool); }
interface IAaveSupply {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external;
    function setUserEMode(uint8 categoryId) external;
    function setUserUseReserveAsCollateral(address asset, bool useAsCollateral) external;
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

    /// DELEGATECALLed by the Safe as the ENTIRE full-close `post` (one SafeTx — the canonical
    /// MultiSend at 0x40A2… is MultiSendCallOnly, which forbids inner delegatecalls, so the sweep
    /// cannot ride inside a MultiSend blob): repay the flash loan, enforce the signed minHF, then
    /// sweep the ENTIRE remaining balance of both position tokens (debt proceeds + collateral dust)
    /// to `receiver`. Balances are read at execution time, so accrued interest / positive slippage
    /// cannot strand dust in the Safe. Zero balances are skipped.
    function closeAndSweep(
        address debtToken, address collToken, address flashwrap, uint256 flashRepay,
        address pool, uint256 minHF, address receiver
    ) external {
        require(receiver != address(0), "sweep to 0");
        require(IERC20S(debtToken).transfer(flashwrap, flashRepay), "flash repay failed");
        if (minHF != 0) {
            (,,,,, uint256 hf) = IAaveSupply(pool).getUserAccountData(address(this));
            require(hf >= minHF, "HF too low");
        }
        uint256 a = IERC20S(debtToken).balanceOf(address(this));
        if (a > 0) require(IERC20S(debtToken).transfer(receiver, a), "sweep debt failed");
        uint256 b = IERC20S(collToken).balanceOf(address(this));
        if (b > 0) require(IERC20S(collToken).transfer(receiver, b), "sweep coll failed");
    }

    /// DELEGATECALLed by the Safe as the ENTIRE open `post` (codex medium: supplying only `buyMin`
    /// left positive slippage idle as plain ERC20): supply the FULL bought collateral balance,
    /// borrow the signed debt, repay the flash loan. One SafeTx — the canonical MultiSend is
    /// CallOnly, so this cannot ride inside a MultiSend blob.
    function openPost(
        address collToken, address pool, address debtToken, uint256 borrowAmt,
        address flashwrap, uint256 repayAmt
    ) external {
        uint256 amt = IERC20S(collToken).balanceOf(address(this));
        require(amt > 0, "nothing to supply");
        IERC20S(collToken).approve(pool, amt);
        IAaveSupply(pool).supply(collToken, amt, address(this), 0);
        IAaveSupply(pool).borrow(debtToken, borrowAmt, 2, 0, address(this));
        require(IERC20S(debtToken).transfer(flashwrap, repayAmt), "flash repay failed");
    }

    /// openPost + eMode: identical, but enters the signed Aave eMode category AFTER the supply and
    /// BEFORE the borrow, so the category's boosted LTV applies to the borrow. Some pairs (e.g.
    /// sDAI collateral on Gnosis, base LTV 0) only support leverage at all inside their category.
    /// eModeCategory 0 = no eMode (skipped).
    function openPostE(
        address collToken, address pool, address debtToken, uint256 borrowAmt,
        address flashwrap, uint256 repayAmt, uint8 eModeCategory
    ) external {
        uint256 amt = IERC20S(collToken).balanceOf(address(this));
        require(amt > 0, "nothing to supply");
        IERC20S(collToken).approve(pool, amt);
        IAaveSupply(pool).supply(collToken, amt, address(this), 0);
        if (eModeCategory != 0) {
            IAaveSupply(pool).setUserEMode(eModeCategory);
            // assets with base LTV 0 (e.g. sDAI) are NOT auto-enabled as collateral on supply —
            // inside their category they must be enabled explicitly or the borrow LTV-validates to 0
            IAaveSupply(pool).setUserUseReserveAsCollateral(collToken, true);
        }
        IAaveSupply(pool).borrow(debtToken, borrowAmt, 2, 0, address(this));
        require(IERC20S(debtToken).transfer(flashwrap, repayAmt), "flash repay failed");
    }

    /// ADAPTIVE open post: the user funds the Safe with EXACTLY their stated amount; settlement
    /// fees make the delivered equity slightly smaller and unknowable at signing time. Instead of
    /// pre-buying a buffer, read the ACTUAL debt-token balance at execution and borrow precisely
    /// what's missing for the flash repayment. Fees shift the borrow (≈ bps of leverage), never
    /// the user's outlay. Supply-all + eMode behaviour identical to openPostE.
    function openPostA(
        address collToken, address pool, address debtToken,
        address flashwrap, uint256 repayAmt, uint8 eModeCategory, uint256 minHF
    ) external {
        uint256 amt = IERC20S(collToken).balanceOf(address(this));
        require(amt > 0, "nothing to supply");
        IERC20S(collToken).approve(pool, amt);
        IAaveSupply(pool).supply(collToken, amt, address(this), 0);
        if (eModeCategory != 0) {
            IAaveSupply(pool).setUserEMode(eModeCategory);
            IAaveSupply(pool).setUserUseReserveAsCollateral(collToken, true);
        }
        uint256 have = IERC20S(debtToken).balanceOf(address(this));
        if (have < repayAmt) IAaveSupply(pool).borrow(debtToken, repayAmt - have, 2, 0, address(this));
        require(IERC20S(debtToken).transfer(flashwrap, repayAmt), "flash repay failed");
        // signed safety floor (codex high): the adaptive borrow covers whatever the settlement fee
        // shaved off the delivered equity — but a solver under-delivering within the carrier's price
        // tolerance would push that gap into the user's debt. Enforce the owner-signed post-open HF
        // so any such under-delivery reverts the whole settlement instead of opening a worse position.
        if (minHF != 0) {
            (,,,,, uint256 hf) = IAaveSupply(pool).getUserAccountData(address(this));
            require(hf >= minHF, "HF too low");
        }
    }
}
