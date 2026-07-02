// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.34;

interface IERC20Permit {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface ISavingsXDaiAdapterRedeem {
    /// @notice Redeem ALL of the caller's sDAI into native xDAI, sent to `receiver`.
    function redeemAllXDAI(address receiver) external returns (uint256 assets);
}

interface IHomeOmnibridge {
    /// @notice Burn `msg.value` native xDAI on Gnosis and release the bridged token
    ///         (USDS post-migration) 1:1 to `_receiver` on Ethereum mainnet.
    function relayTokens(address _receiver) external payable;
}

/**
 * @title ReturnRouter
 * @notice One-transaction reverse leg: Gnosis **sDAI → mainnet USDS**. The user
 *         signs a single EIP-2612 `permit` for their sDAI; this router then, in
 *         one call:
 *
 *           1. `permit` + `transferFrom` pulls the user's sDAI into the router;
 *           2. `redeemAllXDAI` unwinds it to native xDAI (sDAI→wxDAI→xDAI, 1:1);
 *           3. `relayTokens{value}` hands the native xDAI to the Home Omnibridge,
 *              which credits USDS to `mainnetRecipient` on Ethereum after the
 *              validators sign (the mainnet `executeSignatures` claim is run by a
 *              relayer/keeper — see scripts).
 *
 *         Stateless and holds no funds between calls (the redeemed xDAI is bridged
 *         out in the same tx). The Home bridge enforces a **10 xDAI minPerTx**, so
 *         redeemed value below that reverts up front with a clear error.
 *
 * @dev Deploy once on Gnosis Chain. `receive()` accepts the native xDAI that the
 *      adapter sends back during `redeemAllXDAI`.
 */
contract ReturnRouter {
    /// @dev sDAI (SavingsDai, EIP-2612 permit) on Gnosis.
    IERC20Permit public constant SDAI = IERC20Permit(0xaf204776c7245bF4147c2612BF6e5972Ee483701);
    /// @dev SavingsXDaiAdapter (Spark) on Gnosis.
    ISavingsXDaiAdapterRedeem public constant ADAPTER =
        ISavingsXDaiAdapterRedeem(0xD499b51fcFc66bd31248ef4b28d656d67E591A94);
    /// @dev USDS bridge router (Gnosis). A thin forwarder to the Home xDAI bridge
    ///      whose withdrawals settle as **USDS** on mainnet (routing directly through
    ///      the Home bridge settles as DAI). Empirically verified: withdrawals via
    ///      this address deliver USDS. Its `relayTokens{value}(receiver)` calls the
    ///      Home bridge (`0x7301…`) with itself as caller.
    IHomeOmnibridge public constant USDS_ROUTER = IHomeOmnibridge(0x5C183C8A49aBA6e31049997a56D75600E27FF8c9);
    /// @dev Home bridge minimum per transfer (verified on-chain: 10 xDAI).
    uint256 public constant MIN_PER_TX = 10 ether;

    event Returned(address indexed user, address indexed mainnetRecipient, uint256 sdaiIn, uint256 xdaiBridged);

    /**
     * @param amount           sDAI to redeem and bridge (the permit `value`).
     * @param mainnetRecipient address to receive USDS on Ethereum mainnet.
     * @param deadline,v,r,s   EIP-2612 permit signed by the user over
     *                         (owner=msg.sender, spender=this, value=amount).
     */
    function returnToMainnet(uint256 amount, address mainnetRecipient, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
        require(mainnetRecipient != address(0), "recipient=0");
        SDAI.permit(msg.sender, address(this), amount, deadline, v, r, s);
        require(SDAI.transferFrom(msg.sender, address(this), amount), "sDAI pull failed");
        SDAI.approve(address(ADAPTER), amount);

        // Redeem to native xDAI; measure by balance delta so we don't depend on
        // the adapter's return value. (Router holds no idle sDAI, so redeemAll
        // unwinds exactly the amount just pulled.)
        uint256 before = address(this).balance;
        ADAPTER.redeemAllXDAI(address(this));
        uint256 xdai = address(this).balance - before;

        require(xdai >= MIN_PER_TX, "below bridge min (10 xDAI)");
        // Route through the USDS router so the mainnet side settles as USDS (not DAI).
        USDS_ROUTER.relayTokens{value: xdai}(mainnetRecipient);
        emit Returned(msg.sender, mainnetRecipient, amount, xdai);
    }

    receive() external payable {}
}
