// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Twap} from "./libraries/Twap.sol";
import {
    IComposableCoW,
    IConditionalOrder,
    ISignatureVerifierMuxer,
    ISafeSignatureVerifier,
    IValueFactory
} from "./interfaces/ICoW.sol";

/**
 * @title TwapBalanceInitializer
 * @notice Like {TwapSafeInitializer}, but sizes the TWAP from the Safe's OWN
 *         balance at deploy time instead of from a fixed amount baked in at sign
 *         time — eliminating leftover "dust".
 *
 *         The carrier flow funds the Safe by an in-kind CoW order whose fill
 *         delivers `~sellAmount` to the (counterfactual) Safe address, then a
 *         CoW POST-interaction deploys the Safe. Because the post-interaction
 *         runs AFTER the fill, by the time this initializer is `DELEGATECALL`ed
 *         from `Safe.setup()` the Safe already holds the funds, so it can read
 *         `sellToken.balanceOf(address(this))` and split it EXACTLY into `n`
 *         parts: `partSellAmount = balance / n`. The standard, audited TWAP
 *         handler then sells `n * (balance / n) == balance` (minus a sub-`n`-wei
 *         integer remainder) — no dust, and the user spends their full input.
 *
 *         Crucially the per-part amount is NOT an argument, so it is not part of
 *         the Safe's `setup()` calldata and therefore not part of the CREATE2
 *         salt: the Safe address still commits to (owner, tokens, n, t, span,
 *         limit rate, salt, appData) — everything known at sign time — and is
 *         predictable before the carrier is signed. Only the floating amount,
 *         which couldn't be known in advance anyway, is resolved at deploy.
 *
 * @dev    Idempotent-by-construction at the ComposableCoW layer: re-running an
 *         identical setup yields the same order hash. Deploy once per chain at a
 *         deterministic address; the contract is immutable and holds no state.
 */
contract TwapBalanceInitializer {
    using SafeERC20 for IERC20;

    IComposableCoW public constant COMPOSABLE_COW =
        IComposableCoW(0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74);
    IValueFactory public constant CURRENT_BLOCK_TIMESTAMP_FACTORY =
        IValueFactory(0x52eD56Da04309Aca4c3FECC595298d80C2f16BAc);
    address public constant VAULT_RELAYER = 0xC92E8bdf79f0507f65a392b0ab4667716BFE0110;

    event TwapSafeInitialized(address indexed safe, address indexed sellToken, bytes32 orderHash);

    /**
     * @param sellToken token the TWAP sells (and what the carrier delivered).
     * @param buyToken  token the TWAP buys.
     * @param receiver  where parts' proceeds go (the user's wallet); address(0)
     *                  would mean the Safe itself.
     * @param n         number of parts (> 1). `partSellAmount = balance / n`.
     * @param t         seconds per part (0 < t <= 365 days).
     * @param span      tradeable window within each part; 0 -> whole part.
     * @param limitNum  limit-price rate numerator; the per-part minimum is
     * @param limitDen  `minPartLimit = partSellAmount * limitNum / limitDen`, so
     *                  the floor scales with the resolved part size. Set from the
     *                  off-chain quote as (estMinPartLimit, estPartSell).
     * @param salt      uniqueness for the conditional order + Safe address.
     * @param appData   CoW appData for the part orders.
     */
    struct Config {
        IERC20 sellToken;
        IERC20 buyToken;
        address receiver;
        uint256 n;
        uint256 t;
        uint256 span;
        uint256 limitNum;
        uint256 limitDen;
        bytes32 salt;
        bytes32 appData;
    }

    /**
     * @dev MUST be reached via `DELEGATECALL` from the Safe during `setup()`,
     *      AFTER the carrier fill has funded the Safe (i.e. as a CoW
     *      post-interaction). Because it runs as the Safe, `address(this)` is the
     *      Safe and all calls below act on the Safe's behalf.
     */
    function initialize(Config calldata c) external {
        require(c.n > 1, "n");
        require(c.limitDen > 0, "den");

        // (1) The whole point: the Safe is already funded (post-interaction ran
        //     after the carrier fill), so split the live balance exactly.
        uint256 bal = c.sellToken.balanceOf(address(this));
        require(bal >= c.n, "unfunded");
        uint256 partSellAmount = bal / c.n;
        uint256 minPartLimit = partSellAmount * c.limitNum / c.limitDen;
        require(minPartLimit > 0, "limit");

        IConditionalOrder.ConditionalOrderParams memory params = Twap.toParams(
            Twap.Data({
                sellToken: c.sellToken,
                buyToken: c.buyToken,
                receiver: c.receiver,
                partSellAmount: partSellAmount,
                minPartLimit: minPartLimit,
                t0: 0, // "start now" — cabinet stamps block.timestamp at deploy
                n: c.n,
                t: c.t,
                span: c.span,
                appData: c.appData
            }),
            c.salt
        );

        // (2) Route GPv2 ERC-1271 checks to ComposableCoW (self-call: onlySelf).
        ISignatureVerifierMuxer(address(this)).setDomainVerifier(
            COMPOSABLE_COW.domainSeparator(), ISafeSignatureVerifier(address(COMPOSABLE_COW))
        );

        // (3) Let the settlement contract pull the sell token for each part.
        //     Approve the whole balance — the parts consume exactly it.
        c.sellToken.forceApprove(VAULT_RELAYER, bal);

        // (4) Register the order; stamp the start time ("now") into the cabinet.
        COMPOSABLE_COW.createWithContext(params, CURRENT_BLOCK_TIMESTAMP_FACTORY, "", true);

        emit TwapSafeInitialized(address(this), address(c.sellToken), COMPOSABLE_COW.hash(params));
    }
}
