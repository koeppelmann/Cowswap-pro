import { useState, useEffect, useRef } from "react";
import { Link } from "wouter";
import { Settings, ChevronDown, RefreshCw, Wallet, ArrowDown, Info, ExternalLink, X, TrendingUp, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import logo from "@assets/logo.svg";
import { ConfirmSwapDialog } from "@/components/confirm-swap-dialog";

type Token = {
  symbol: string;
  name: string;
  price: number;
  icon: string;
};

const TOKENS: Token[] = [
  { symbol: "USDC", name: "USD Coin", price: 1, icon: "https://cryptologos.cc/logos/usd-coin-usdc-logo.png?v=024" },
  { symbol: "WETH", name: "Wrapped Ethereum", price: 2800, icon: "https://cryptologos.cc/logos/ethereum-eth-logo.png?v=024" },
  { symbol: "WBTC", name: "Wrapped Bitcoin", price: 65000, icon: "https://cryptologos.cc/logos/bitcoin-btc-logo.png?v=024" },
  { symbol: "GNO", name: "Gnosis", price: 300, icon: "https://cryptologos.cc/logos/gnosis-gno-gno-logo.png?v=024" },
  { symbol: "DAI", name: "Dai", price: 1, icon: "https://cryptologos.cc/logos/multi-collateral-dai-dai-logo.png?v=024" },
];

type Position = {
  id: string;
  collateralToken: Token;
  debtToken: Token;
  collateralAmount: number;
  debtAmount: number;
  leverage: number;
  entryPrice: number;
  timestamp: number;
};

export default function SwapPage() {
  const [payAmount, setPayAmount] = useState<string>("10000");
  const [leverage, setLeverage] = useState<number[]>([1]); // Default 1x (inactive)
  const [showLeverage, setShowLeverage] = useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isPriceFlipped, setIsPriceFlipped] = useState(false);
  
  const [sellToken, setSellToken] = useState<Token | Position>(TOKENS[0]); // USDC or Position
  const [buyToken, setBuyToken] = useState<Token>(TOKENS[1]);   // WETH
  
  const [positions, setPositions] = useState<Position[]>([]);

  const [isTokenSelectOpen, setIsTokenSelectOpen] = useState(false);
  const [selectingSide, setSelectingSide] = useState<'sell' | 'buy'>('sell');
  const [searchQuery, setSearchQuery] = useState("");
  const [positionMode, setPositionMode] = useState<'close' | 'leverage'>('close');

  const isPosition = (token: any): token is Position => {
    return 'collateralAmount' in token;
  };

  const activePosition = isPosition(sellToken) ? sellToken : null;

  // Price logic depends on whether we are selling a token or a position
  // If selling a position, sellToken is the Position object.
  // We need to resolve the underlying tokens for price calc.
  
  const underlyingSellToken = isPosition(sellToken) ? sellToken.collateralToken : sellToken;
  const underlyingBuyToken = buyToken;

  const ethPrice = underlyingBuyToken.price / underlyingSellToken.price; // Relative price

  const leverageOverlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (leverageOverlayRef.current && !leverageOverlayRef.current.contains(event.target as Node)) {
        setShowLeverage(false);
      }
    };

    if (showLeverage) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [showLeverage]);

  // Calculate logic
  const rawBuyAmount = parseFloat(payAmount || "0") / ethPrice;
  
  // If selling a position:
  // - The input "payAmount" is now treated as a PERCENTAGE (0-100) if we are in position mode.
  // - "Selling 50%" would mean you sell 50% of the position.
  
  const activeLeverage = isPosition(sellToken) && positionMode === 'close' ? 1 : leverage[0]; // If closing, no new leverage on the trade itself
  
  // If closing position, calculate proceeds based on equity
  // Equity = (Collateral * Price) - Debt
  // Proceeds = Equity * (PercentSold / 100)
  
  let leveragedBuyAmount = 0;
  let equitySoldValue = 0;
  
  if (isPosition(sellToken) && positionMode === 'close') {
      const collateralPrice = sellToken.collateralToken.price;
      const debtPrice = sellToken.debtToken.price;
      const totalEquity = (sellToken.collateralAmount * collateralPrice) - (sellToken.debtAmount * debtPrice);
      
      const percentSold = payAmount ? parseFloat(payAmount) : 100; // Default to 100% if empty
      const fractionSold = percentSold / 100;
      
      const equitySold = totalEquity * fractionSold;
      equitySoldValue = equitySold;
      
      // Convert equity (USD) to BuyToken amount
      leveragedBuyAmount = equitySold / buyToken.price;
      if (leveragedBuyAmount < 0) leveragedBuyAmount = 0;
  } else {
      leveragedBuyAmount = rawBuyAmount * activeLeverage;
  }
  
  const formattedBuyAmount = leveragedBuyAmount.toFixed(4);
  
  // Display Value Logic
  let formattedUsdValue = "";
  if (isPosition(sellToken) && positionMode === 'close') {
      formattedUsdValue = equitySoldValue.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  } else {
      formattedUsdValue = (parseFloat(payAmount || "0") * activeLeverage * underlyingSellToken.price).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }

  // Debt/Liquidation logic only applies if we are OPENING a position (normal token sell) AND leverage > 1
  const showPositionStats = !isPosition(sellToken) && activeLeverage > 1;

  // ... (Debt/Liquidation calcs use showPositionStats to conditionalize or just run)
  const debtAmount = (parseFloat(payAmount || "0") * activeLeverage) - parseFloat(payAmount || "0");
  const formattedDebt = `${debtAmount.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${underlyingSellToken.symbol}`;

  // Liquidation calcs
  const liquidationThreshold = 0.8; // 80% LTV roughly
  const liquidationPrice = activeLeverage > 1 
    ? ethPrice * (1 - (1 / activeLeverage) * liquidationThreshold)
    : 0;

  const handleSwapConfirm = () => {
    if (isPosition(sellToken)) {
        if (positionMode === 'leverage') {
             // Adjust leverage logic
             setPositions(prev => prev.map(p => {
                if (p.id === sellToken.id) {
                     // Recalculate amounts based on new leverage
                     const collateralValue = p.collateralAmount * p.collateralToken.price;
                     const debtValue = p.debtAmount * p.debtToken.price;
                     const equity = collateralValue - debtValue;
                     
                     const newCollateralValue = equity * leverage[0];
                     const newDebtValue = newCollateralValue - equity;
                     
                     return {
                        ...p,
                        collateralAmount: newCollateralValue / p.collateralToken.price,
                        debtAmount: Math.max(0, newDebtValue / p.debtToken.price),
                        leverage: leverage[0]
                     };
                }
                return p;
             }));
             
             // After leverage adjustment, reset to initial swap view
             setSellToken(TOKENS[0]); // Reset to first token (usually USDC)
             setBuyToken(TOKENS[2]); // Reset to ETH (or WETH equivalent in list)
             setLeverage([1]); // Reset leverage slider
        } else {
            // Closing position logic (mock)
            const percentSold = parseFloat(payAmount); // Input is now %
            const fractionSold = percentSold / 100;
            
            if (fractionSold >= 0.99) {
                // Full close
                setPositions(prev => prev.filter(p => p.id !== sellToken.id));
                setSellToken(sellToken.collateralToken); // Reset to token
                setLeverage([1]);
            } else {
                // Partial close - update position
                setPositions(prev => prev.map(p => {
                    if (p.id === sellToken.id) {
                        return {
                            ...p,
                            collateralAmount: p.collateralAmount * (1 - fractionSold),
                            debtAmount: p.debtAmount * (1 - fractionSold) // Proportional debt repayment
                        };
                    }
                    return p;
                }));
                // Even on partial close, maybe we want to reset?
                setSellToken(sellToken.collateralToken); 
                setLeverage([1]);
            }
        }
    } else if (activeLeverage > 1) {
        // Open new position
        const newPosition: Position = {
            id: Math.random().toString(36).substr(2, 9),
            collateralToken: buyToken, // We bought this
            debtToken: sellToken,      // We owe this
            collateralAmount: parseFloat(formattedBuyAmount),
            debtAmount: debtAmount,
            leverage: activeLeverage,
            entryPrice: ethPrice,
            timestamp: Date.now()
        };
        setPositions(prev => [...prev, newPosition]);
    }
    
    setIsConfirmOpen(false);
    setPayAmount("");
  };

  // ... (Rest of component)
  
  // In TokenSelect:
  // Add section for Positions if selectingSide === 'sell'

  const getMoneynessRank = (symbol: string) => {
    if (["USDC", "USDT", "DAI"].includes(symbol)) return 0;
    if (symbol === "WBTC") return 1;
    if (symbol === "WETH") return 2;
    if (symbol === "GNO") return 3;
    return 4;
  };

  // Determine display price based on moneyness
  const sellRank = getMoneynessRank(underlyingSellToken.symbol);
  const buyRank = getMoneynessRank(buyToken.symbol);
  
  let displayLiquidationPrice = "";
  let numericLiqPrice = 0;
  let numericCurrentPrice = 0;

  // We want to express price of "Other" (Higher Rank Value) in terms of "More Money" (Lower Rank Value).
  // liquidationPrice variable is "Price of BuyToken in SellToken terms" (SellToken per BuyToken)
  
  if (sellRank < buyRank) {
    // Sell is "More Money" (e.g. USDC). Buy is "Other" (e.g. ETH).
    numericLiqPrice = liquidationPrice;
    numericCurrentPrice = ethPrice;
    displayLiquidationPrice = `${liquidationPrice.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${underlyingSellToken.symbol}`;
  } else if (buyRank < sellRank) {
    // Buy is "More Money" (e.g. USDC). Sell is "Other" (e.g. ETH).
    numericLiqPrice = liquidationPrice > 0 ? 1 / liquidationPrice : 0;
    numericCurrentPrice = ethPrice > 0 ? 1 / ethPrice : 0;
    displayLiquidationPrice = `${numericLiqPrice.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${buyToken.symbol}`;
  } else {
    // Equal moneyness (e.g. USDC vs USDT). Default to standard (Sell per Buy).
    numericLiqPrice = liquidationPrice;
    numericCurrentPrice = ethPrice;
    displayLiquidationPrice = `${liquidationPrice.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${underlyingSellToken.symbol}`;
  }

  const formattedLiquidationPrice = displayLiquidationPrice;
  const liquidationDrop = activeLeverage > 1 && numericCurrentPrice > 0
    ? ((numericLiqPrice - numericCurrentPrice) / numericCurrentPrice) * 100 
    : 0;

  // Quote Exchange Rate Display Logic
  let displayQuote = "";
  // Check moneyness for default direction
  const defaultShowBuyInSell = sellRank < buyRank; // Sell is money, Buy is asset -> Show "1 Asset = X Money" (e.g. 1 ETH = 2800 USDC)
  
  // If we should flip (user toggled), we invert the default preference
  const showBuyInSell = isPriceFlipped ? !defaultShowBuyInSell : defaultShowBuyInSell;

  if (showBuyInSell) {
    // 1 BuyToken = X SellToken
    // ethPrice is Sell per Buy (e.g. 2800).
    displayQuote = `1 ${buyToken.symbol} = ${ethPrice.toFixed(4)} ${underlyingSellToken.symbol}`;
  } else {
    // 1 SellToken = Y BuyToken
    const invPrice = ethPrice > 0 ? 1 / ethPrice : 0;
    displayQuote = `1 ${underlyingSellToken.symbol} = ${invPrice.toFixed(6)} ${buyToken.symbol}`;
  }

  const handleTokenSelect = (token: Token | Position) => {
    if (selectingSide === 'sell') {
      if (!isPosition(token) && token.symbol === buyToken.symbol) {
        setBuyToken(sellToken as Token); // Swap if same (only if token)
      }
      setSellToken(token);
      // If position selected, default amount to 100%
      if (isPosition(token)) {
          setPayAmount("100");
      }
    } else {
      if (!isPosition(sellToken) && !isPosition(token) && token.symbol === (sellToken as Token).symbol) {
        setSellToken(buyToken); // Swap if same
      }
      // If sellToken is position, buying same underlying token means Deleverage?
      setBuyToken(token as Token);
    }
    setIsTokenSelectOpen(false);
    setSearchQuery("");
  };

  const openTokenSelect = (side: 'sell' | 'buy') => {
    setSelectingSide(side);
    setIsTokenSelectOpen(true);
  };

  const filteredTokens = TOKENS.filter(t => 
    t.symbol.toLowerCase().includes(searchQuery.toLowerCase()) || 
    t.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  let positionDetails = undefined;
  if (isPosition(sellToken) && positionMode === 'leverage') {
      const collateralValue = sellToken.collateralAmount * sellToken.collateralToken.price;
      const debtValue = sellToken.debtAmount * sellToken.debtToken.price;
      const equity = collateralValue - debtValue;
      
      const newCollateralValue = equity * leverage[0];
      const newDebtValue = newCollateralValue - equity;
      
      const newCollateralAmount = newCollateralValue / sellToken.collateralToken.price;
      const newDebtAmount = Math.max(0, newDebtValue / sellToken.debtToken.price);
      
      positionDetails = {
          collateralToken: sellToken.collateralToken,
          debtToken: sellToken.debtToken,
          current: {
              collateralAmount: sellToken.collateralAmount,
              debtAmount: sellToken.debtAmount,
              leverage: sellToken.leverage
          },
          target: {
              collateralAmount: newCollateralAmount,
              debtAmount: newDebtAmount,
              leverage: leverage[0]
          }
      };
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans">
      {/* Navbar */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-border/10">
        <div className="flex items-center gap-8">
          <div className="flex items-center gap-2">
            <img src={logo} alt="CowSwap" className="w-8 h-8" />
            <span className="text-xl font-bold tracking-tight text-blue-100">CoW Swap</span>
          </div>
          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-muted-foreground">
            <a href="#" className="text-foreground">Swap</a>
            <a href="#" className="hover:text-primary transition-colors">Limit</a>
            <a href="#" className="hover:text-primary transition-colors">TWAP</a>
            <a href="#" className="hover:text-primary transition-colors">Yield</a>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-2 text-sm text-muted-foreground mr-2">
            <span className="w-2 h-2 rounded-full bg-green-500"></span>
            Ethereum
          </div>
          <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground">
            <Settings className="w-5 h-5" />
          </Button>
          <Button className="bg-primary hover:bg-primary/90 text-white font-medium rounded-xl px-5">
            Connect Wallet
          </Button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col items-center justify-center p-4 relative overflow-hidden">
        
        {/* Background Particles/Stars Mockup */}
        <div className="absolute inset-0 pointer-events-none opacity-20">
            <div className="absolute top-1/4 left-1/4 w-1 h-1 bg-white rounded-full"></div>
            <div className="absolute top-1/3 left-2/3 w-2 h-2 bg-blue-400 rounded-full blur-[1px]"></div>
            <div className="absolute bottom-1/4 right-1/4 w-1 h-1 bg-white rounded-full"></div>
            <div className="absolute top-1/2 left-1/5 w-1.5 h-1.5 bg-indigo-400 rounded-full blur-[1px]"></div>
        </div>

        <div className="w-full max-w-[480px] space-y-4 relative z-10">
          <div className="flex items-center justify-between mb-2 px-1">
            <div className="flex items-center gap-4 bg-secondary/30 p-1 rounded-xl">
               <button className="px-4 py-1.5 bg-background/50 rounded-lg text-sm font-medium text-foreground shadow-sm">Swap</button>
               <button className="px-4 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">Limit</button>
            </div>
            <div className="flex items-center gap-2">
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground">
                    <RefreshCw className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground">
                    <Settings className="h-4 w-4" />
                </Button>
            </div>
          </div>

          <Card className="border-0 bg-[#12152b] shadow-2xl rounded-3xl overflow-hidden ring-1 ring-white/5">
            <CardContent className="p-4 space-y-1">
              
              {/* Sell Section */}
              <div className="bg-[#0b0e1e] rounded-2xl p-4 transition-colors hover:bg-[#0b0e1e]/80 group relative">
                
                {/* Position Mode Toggle */}
                {isPosition(sellToken) && (
                    <div className="flex justify-end mb-4">
                        <div className="flex bg-secondary/30 p-0.5 rounded-lg z-10">
                            <button 
                                onClick={() => setPositionMode('close')}
                                className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${positionMode === 'close' ? 'bg-primary text-white shadow-sm' : 'text-muted-foreground hover:text-white'}`}
                            >
                                Swap
                            </button>
                            <button 
                                onClick={() => setPositionMode('leverage')}
                                className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${positionMode === 'leverage' ? 'bg-primary text-white shadow-sm' : 'text-muted-foreground hover:text-white'}`}
                            >
                                Adjust Leverage
                            </button>
                        </div>
                    </div>
                )}

                <div className="flex justify-between mb-2">
                    <label className="text-muted-foreground text-sm font-medium">Sell</label>
                    <span className="text-muted-foreground text-sm">
                        {isPosition(sellToken) 
                            ? `Position: ${sellToken.collateralAmount.toFixed(4)} ${sellToken.collateralToken.symbol}` 
                            : `Balance: 0 ${sellToken.symbol}`
                        }
                    </span>
                </div>
                
                {isPosition(sellToken) && positionMode === 'leverage' ? (
                     <div className="py-6 px-2">
                        <div className="flex items-center justify-between mb-4">
                            <span className="text-sm text-muted-foreground">Current Leverage: <span className="text-white font-mono">{sellToken.leverage}x</span></span>
                            <span className="text-sm text-muted-foreground">Target: <span className="text-primary font-bold font-mono">{leverage[0]}x</span></span>
                        </div>
                        <Slider 
                            value={leverage} 
                            onValueChange={setLeverage} 
                            min={1.0} 
                            max={5} 
                            step={0.1}
                            className="py-2"
                        />
                        <div className="flex justify-between mt-2 text-xs text-muted-foreground">
                            <span>1.0x</span>
                            <span>5.0x</span>
                        </div>
                     </div>
                ) : (
                    <>
                        <div className="flex items-center justify-between gap-4">
                        {isPosition(sellToken) ? (
                            <div className="flex items-center w-full border-b border-white/10">
                            <Input 
                                type="number" 
                                value={payAmount}
                                onChange={(e) => {
                                    const val = parseFloat(e.target.value);
                                    if (val > 100) setPayAmount("100");
                                    else setPayAmount(e.target.value);
                                }}
                                className="border-0 bg-transparent text-4xl font-normal p-0 h-auto focus-visible:ring-0 placeholder:text-muted-foreground/50 w-full"
                                placeholder="0"
                            />
                            <span className="text-3xl text-muted-foreground ml-2">%</span>
                            </div>
                        ) : (
                            <Input 
                                type="number" 
                                value={payAmount}
                                onChange={(e) => setPayAmount(e.target.value)}
                                className="border-0 bg-transparent text-4xl font-normal p-0 h-auto focus-visible:ring-0 placeholder:text-muted-foreground/50 w-full"
                                placeholder="0"
                            />
                        )}
                        <Button 
                            variant="secondary" 
                            className="rounded-full h-10 px-3 bg-secondary hover:bg-secondary/80 flex items-center gap-2 min-w-fit"
                            onClick={() => openTokenSelect('sell')}
                        >
                            <div className="w-6 h-6 rounded-full bg-white flex items-center justify-center p-0.5 overflow-hidden">
                                <img src={underlyingSellToken.icon} alt={underlyingSellToken.symbol} className="w-full h-full object-contain" />
                            </div>
                            <span className="text-lg font-medium text-white">
                                {isPosition(sellToken) ? `Pos: ${underlyingSellToken.symbol}` : underlyingSellToken.symbol}
                            </span>
                            <ChevronDown className="h-4 w-4 opacity-50" />
                        </Button>
                        </div>
                        
                        {/* Percentage Shortcuts for Position Closing */}
                        {isPosition(sellToken) && (
                            <div className="flex gap-2 mt-2 mb-1">
                                <button 
                                    onClick={() => setPayAmount("25")}
                                    className="px-2 py-0.5 text-xs bg-secondary/30 hover:bg-secondary/50 rounded text-primary transition-colors"
                                >
                                    25%
                                </button>
                                <button 
                                    onClick={() => setPayAmount("50")}
                                    className="px-2 py-0.5 text-xs bg-secondary/30 hover:bg-secondary/50 rounded text-primary transition-colors"
                                >
                                    50%
                                </button>
                                <button 
                                    onClick={() => setPayAmount("75")}
                                    className="px-2 py-0.5 text-xs bg-secondary/30 hover:bg-secondary/50 rounded text-primary transition-colors"
                                >
                                    75%
                                </button>
                                <button 
                                    onClick={() => setPayAmount("100")}
                                    className="px-2 py-0.5 text-xs bg-secondary/30 hover:bg-secondary/50 rounded text-primary transition-colors"
                                >
                                    Max
                                </button>
                            </div>
                        )}
                        
                        <div className="text-muted-foreground text-sm mt-2">
                            ≈ {formattedUsdValue}
                        </div>
                    </>
                )}
              </div>

              {/* Arrow Connector */}
              <div className="relative h-2 z-10">
                <div className="absolute left-1/2 -translate-x-1/2 -top-4">
                    <div className="bg-[#12152b] p-1.5 rounded-xl border-4 border-[#12152b]">
                        <div 
                            className={`bg-secondary/50 p-1.5 rounded-lg hover:bg-secondary transition-colors cursor-pointer ${isPosition(sellToken) ? 'opacity-50 cursor-not-allowed' : ''}`}
                            onClick={() => {
                                if (!isPosition(sellToken)) {
                                    const temp = sellToken;
                                    setSellToken(buyToken);
                                    setBuyToken(temp as Token);
                                }
                            }}
                        >
                            <ArrowDown className="h-4 w-4 text-foreground" />
                        </div>
                    </div>
                </div>
              </div>

              {/* Buy Section */}
              <div className="bg-[#0b0e1e] rounded-2xl p-4 pt-6 transition-colors hover:bg-[#0b0e1e]/80 relative">
                
                {isPosition(sellToken) && positionMode === 'leverage' ? (
                   // Adjusted Leverage Preview
                   <div className="space-y-4">
                      <div className="flex justify-between items-center mb-2">
                         <span className="text-muted-foreground text-sm font-medium">New Position Details</span>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-4">
                         <div className="bg-secondary/20 p-3 rounded-xl border border-white/5">
                             <div className="text-xs text-muted-foreground mb-1">Collateral</div>
                             <div className="flex items-center gap-2">
                                <img src={sellToken.collateralToken.icon} className="w-5 h-5 rounded-full" />
                                <span className="font-mono text-lg font-medium text-white">
                                    {((((sellToken.collateralAmount * sellToken.collateralToken.price - sellToken.debtAmount * sellToken.debtToken.price) * leverage[0]) / sellToken.collateralToken.price)).toFixed(4)}
                                </span>
                             </div>
                             <div className="text-xs text-muted-foreground mt-1">
                                {sellToken.collateralToken.symbol}
                             </div>
                         </div>
                         
                         <div className="bg-secondary/20 p-3 rounded-xl border border-white/5">
                             <div className="text-xs text-muted-foreground mb-1">Debt</div>
                             <div className="flex items-center gap-2">
                                <img src={sellToken.debtToken.icon} className="w-5 h-5 rounded-full" />
                                <span className="font-mono text-lg font-medium text-white">
                                    {Math.max(0, (((((sellToken.collateralAmount * sellToken.collateralToken.price - sellToken.debtAmount * sellToken.debtToken.price) * leverage[0]) - (sellToken.collateralAmount * sellToken.collateralToken.price - sellToken.debtAmount * sellToken.debtToken.price)) / sellToken.debtToken.price))).toFixed(4)}
                                </span>
                             </div>
                             <div className="text-xs text-muted-foreground mt-1">
                                {sellToken.debtToken.symbol}
                             </div>
                         </div>
                      </div>
                   </div>
                ) : (
                <>
                <div className="flex justify-between mb-2">
                    <div className="flex items-center gap-2">
                        <label className="text-muted-foreground text-sm font-medium">Buy</label>
                        {!isPosition(sellToken) && !showLeverage && (
                            <button 
                                onClick={() => {
                                    setShowLeverage(true);
                                    if (leverage[0] === 1) {
                                      setLeverage([2]); // Default to 2x when opened IF currently 1x
                                    }
                                }}
                                className={`group relative flex items-center gap-1.5 px-2 py-0.5 rounded-full transition-all border ${
                                  leverage[0] > 1 
                                    ? "bg-primary text-white border-primary hover:bg-primary/90"
                                    : "bg-primary/10 hover:bg-primary/20 border-primary/20 hover:border-primary/50 animate-pulse hover:animate-none"
                                }`}
                            >
                                <TrendingUp className={`w-3 h-3 ${leverage[0] > 1 ? "text-white" : "text-primary"}`} />
                                <span className={`text-[10px] font-bold ${leverage[0] > 1 ? "text-white" : "text-primary"}`}>
                                    {leverage[0] > 1 ? `${leverage[0]}x Leverage` : "Add Leverage"}
                                </span>
                            </button>
                        )}
                        {isPosition(sellToken) && (
                             <span className="text-[10px] bg-primary/20 text-primary px-2 py-0.5 rounded-full font-bold">
                                Closing Position ({((parseFloat(payAmount)/sellToken.collateralAmount)*100).toFixed(0)}%)
                             </span>
                        )}
                    </div>
                    <span className="text-muted-foreground text-sm">Balance: 0 {buyToken.symbol}</span>
                </div>
                
                <div className="flex items-center justify-between gap-4">
                  <Input 
                    readOnly
                    value={formattedBuyAmount}
                    className="border-0 bg-transparent text-4xl font-normal p-0 h-auto focus-visible:ring-0 text-primary w-full cursor-default"
                  />
                  <Button 
                    variant="secondary" 
                    className="rounded-full h-10 px-3 bg-secondary hover:bg-secondary/80 flex items-center gap-2 min-w-fit"
                    onClick={() => openTokenSelect('buy')}
                  >
                    <div className="w-6 h-6 rounded-full bg-white flex items-center justify-center overflow-hidden p-0.5">
                        <img src={buyToken.icon} alt={buyToken.symbol} className="w-full h-full object-contain" />
                    </div>
                    <span className="text-lg font-medium text-white">{buyToken.symbol}</span>
                    <ChevronDown className="h-4 w-4 opacity-50" />
                  </Button>
                </div>
                
                <div className="flex flex-col gap-1 mt-2">
                     <div className="flex items-center gap-2">
                        <span className="text-green-400 text-sm">≈ {formattedUsdValue}</span>
                     </div>
                     {showPositionStats && (
                        <div className="flex items-center gap-4 animate-in fade-in slide-in-from-top-1 duration-200">
                            <div className="flex items-center gap-1.5 text-muted-foreground">
                                <span className="text-xs font-medium">Debt:</span>
                                <span className="text-xs font-mono font-bold">{formattedDebt}</span>
                            </div>
                            <div className="flex items-center gap-1.5 text-muted-foreground">
                                <span className="text-xs font-medium">Deleverage Price:</span>
                                <span className="text-xs font-mono font-bold">
                                    {formattedLiquidationPrice}
                                    <span className="ml-1 opacity-80 font-sans font-normal">
                                        ({liquidationDrop > 0 ? "+" : ""}{liquidationDrop.toFixed(2)}%)
                                    </span>
                                </span>
                            </div>
                        </div>
                     )}
                </div>
                </>
                )}

                {/* LEVERAGE OVERLAY - Compact & High */}
                {!isPosition(sellToken) && showLeverage && (
                    <div className="absolute -top-5 left-2 right-2 z-20" ref={leverageOverlayRef}>
                        <div className="bg-[#1a1d3d] border border-primary/20 rounded-xl shadow-lg p-3 animate-in fade-in slide-in-from-bottom-2 duration-200">
                            <div className="flex items-center gap-3">
                                <div className="flex flex-col gap-0.5 min-w-[60px]">
                                    <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Leverage</span>
                                    <span className="text-primary font-bold font-mono text-sm">
                                        {leverage[0]}x
                                    </span>
                                </div>
                                
                                <div className="flex-1 px-1">
                                    <Slider 
                                        value={leverage} 
                                        onValueChange={setLeverage} 
                                        min={1.0} 
                                        max={5} 
                                        step={0.1}
                                        className="py-2"
                                    />
                                </div>

                                <button 
                                    onClick={() => {
                                        setShowLeverage(false);
                                    }}
                                    className="text-muted-foreground hover:text-white transition-colors p-1 hover:bg-white/5 rounded-md"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                    </div>
                )}

              </div>

              {/* Quote Info */}
              <div className="mt-2 px-2 py-3">
                 <div 
                    className="flex justify-between items-center text-sm text-muted-foreground hover:text-foreground/80 transition-colors cursor-pointer group select-none"
                    onClick={() => setIsPriceFlipped(!isPriceFlipped)}
                 >
                    <div className="flex items-center gap-1">
                        <span>{displayQuote}</span>
                    </div>
                    <div className="flex items-center gap-1 text-xs">
                        <span className="text-foreground">~$4.50</span>
                        <ChevronDown className="h-3 w-3" />
                    </div>
                 </div>
              </div>

          <Button 
            className="w-full h-14 text-xl font-semibold rounded-2xl mt-4 bg-primary hover:bg-primary/90 text-white shadow-lg shadow-blue-500/20"
            onClick={() => setIsConfirmOpen(true)}
          >
            {isPosition(sellToken) && positionMode === 'close' 
                ? "Swap" 
                : isPosition(sellToken) && positionMode === 'leverage'
                  ? leverage[0] === 1.0 
                      ? "Close Position" 
                      : leverage[0] > sellToken.leverage
                          ? "Increase Leverage"
                          : leverage[0] < sellToken.leverage
                              ? "Decrease Leverage"
                              : "Adjust Leverage"
                  : (payAmount ? "Swap" : "Enter an amount")
            }
          </Button>

              {activeLeverage > 1 && !isPosition(sellToken) && (
                  <div className="mt-3 text-center">
                    <p className="text-xs text-muted-foreground">
                        Leverage powered by <span className="text-foreground font-medium">Aave V3</span> integration.
                    </p>
                  </div>
              )}

            </CardContent>
          </Card>

          {/* Footer Info */}
          <div className="text-center">
              <p className="text-xs text-muted-foreground/50">
                  CoW Protocol protects you from MEV
              </p>
          </div>
        </div>
        
        <ConfirmSwapDialog 
            open={isConfirmOpen} 
            onOpenChange={setIsConfirmOpen}
            payAmount={payAmount}
            buyAmount={formattedBuyAmount}
            leverage={activeLeverage}
            ethPrice={ethPrice}
            debt={formattedDebt}
            liquidationPrice={formattedLiquidationPrice}
            liquidationDrop={liquidationDrop}
            sellToken={underlyingSellToken}
            buyToken={buyToken}
            onConfirm={handleSwapConfirm}
            position={positionDetails}
            isPosition={isPosition(sellToken)}
        />

        {/* Token Select Dialog */}
        <Dialog open={isTokenSelectOpen} onOpenChange={setIsTokenSelectOpen}>
            <DialogContent className="bg-[#12152b] border-white/10 text-foreground sm:max-w-[420px] p-0 gap-0">
                <DialogHeader className="px-4 py-3 border-b border-white/5">
                    <DialogTitle>Select a token</DialogTitle>
                </DialogHeader>
                <div className="p-4">
                    <div className="relative mb-4">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <Input 
                            placeholder="Search name or paste address" 
                            className="bg-[#0b0e1e] border-white/10 pl-9"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                        />
                    </div>
                    <div className="space-y-1 max-h-[300px] overflow-y-auto">
                        {/* Positions Section */}
                        {positions.length > 0 && selectingSide === 'sell' && (
                            <div className="mb-2">
                                <div className="text-xs font-semibold text-muted-foreground px-2 mb-1">Your Positions</div>
                                {positions.map((pos) => (
                                    <button
                                        key={pos.id}
                                        onClick={() => handleTokenSelect(pos)}
                                        className="w-full flex items-center justify-between p-2 rounded-lg hover:bg-white/5 transition-colors mb-1 border border-white/5 bg-white/5"
                                    >
                                        <div className="flex items-center gap-3">
                                            <div className="w-8 h-8 rounded-full bg-white p-0.5 overflow-hidden ring-2 ring-primary/20">
                                                <img src={pos.collateralToken.icon} alt={pos.collateralToken.symbol} className="w-full h-full object-contain" />
                                            </div>
                                            <div className="text-left">
                                                <div className="font-medium flex items-center gap-2">
                                                    {pos.collateralToken.symbol} 
                                                    <span className="text-[10px] bg-primary/20 text-primary px-1.5 py-0.5 rounded-full">{pos.leverage}x</span>
                                                </div>
                                                <div className="text-xs text-muted-foreground">
                                                    Collat: {pos.collateralAmount.toFixed(4)} • Debt: {pos.debtAmount.toFixed(4)} {pos.debtToken.symbol}
                                                </div>
                                            </div>
                                        </div>
                                    </button>
                                ))}
                                <div className="h-px bg-white/5 my-2"></div>
                            </div>
                        )}

                        <div className="text-xs font-semibold text-muted-foreground px-2 mb-1">Tokens</div>
                        {filteredTokens.map((token) => (
                            <button
                                key={token.symbol}
                                onClick={() => handleTokenSelect(token)}
                                className={`w-full flex items-center justify-between p-2 rounded-lg hover:bg-white/5 transition-colors ${
                                    (!isPosition(sellToken) && selectingSide === 'sell' && sellToken.symbol === token.symbol) || 
                                    (selectingSide === 'buy' && buyToken.symbol === token.symbol) 
                                        ? 'opacity-50 cursor-default' 
                                        : ''
                                }`}
                                disabled={
                                    (!isPosition(sellToken) && selectingSide === 'sell' && sellToken.symbol === token.symbol) || 
                                    (selectingSide === 'buy' && buyToken.symbol === token.symbol)
                                }
                            >
                                <div className="flex items-center gap-3">
                                    <div className="w-8 h-8 rounded-full bg-white p-0.5 overflow-hidden">
                                        <img src={token.icon} alt={token.symbol} className="w-full h-full object-contain" />
                                    </div>
                                    <div className="text-left">
                                        <div className="font-medium">{token.symbol}</div>
                                        <div className="text-xs text-muted-foreground">{token.name}</div>
                                    </div>
                                </div>
                                {((!isPosition(sellToken) && selectingSide === 'sell' && sellToken.symbol === token.symbol) || 
                                 (selectingSide === 'buy' && buyToken.symbol === token.symbol)) && (
                                    <div className="text-xs text-primary">Selected</div>
                                )}
                            </button>
                        ))}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
      </main>
    </div>
  );
}
