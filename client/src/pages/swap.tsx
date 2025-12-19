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
  icon: string;
  price: number;
};

const TOKENS: Token[] = [
  { symbol: "USDC", name: "USD Coin", icon: "https://cryptologos.cc/logos/usd-coin-usdc-logo.svg?v=026", price: 1.0 },
  { symbol: "WETH", name: "Wrapped Ether", icon: "https://cryptologos.cc/logos/ethereum-eth-logo.svg?v=026", price: 2823.35 },
  { symbol: "WBTC", name: "Wrapped Bitcoin", icon: "https://cryptologos.cc/logos/bitcoin-btc-logo.svg?v=026", price: 92450.0 },
  { symbol: "DAI", name: "Dai Stablecoin", icon: "https://cryptologos.cc/logos/multi-collateral-dai-dai-logo.svg?v=026", price: 1.0 },
  { symbol: "USDT", name: "Tether USD", icon: "https://cryptologos.cc/logos/tether-usdt-logo.svg?v=026", price: 1.0 },
  { symbol: "GNO", name: "Gnosis", icon: "https://cryptologos.cc/logos/gnosis-gno-gno-logo.svg?v=026", price: 120.0 },
];

export default function SwapPage() {
  const [payAmount, setPayAmount] = useState<string>("10000");
  const [leverage, setLeverage] = useState<number[]>([1]); // Default 1x (inactive)
  const [showLeverage, setShowLeverage] = useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  
  const [sellToken, setSellToken] = useState<Token>(TOKENS[0]); // USDC
  const [buyToken, setBuyToken] = useState<Token>(TOKENS[1]);   // WETH
  
  const [isTokenSelectOpen, setIsTokenSelectOpen] = useState(false);
  const [selectingSide, setSelectingSide] = useState<'sell' | 'buy'>('sell');
  const [searchQuery, setSearchQuery] = useState("");

  const ethPrice = buyToken.price / sellToken.price; // Relative price

  const leverageOverlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (leverageOverlayRef.current && !leverageOverlayRef.current.contains(event.target as Node)) {
        setShowLeverage(false);
      }
    }

    if (showLeverage) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [showLeverage]);

  // Calculate buy amount based on leverage
  // Normal amount = payAmount / ethPrice (relative)
  const rawBuyAmount = parseFloat(payAmount || "0") / ethPrice;
  const activeLeverage = leverage[0];
  const leveragedBuyAmount = rawBuyAmount * activeLeverage;
  
  const formattedBuyAmount = leveragedBuyAmount.toFixed(4);
  const formattedUsdValue = (parseFloat(payAmount || "0") * activeLeverage * sellToken.price).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  
  // Debt Calculation
  // Debt = Total Position Value - Collateral (Pay Amount)
  // Debt = (Pay Amount * Leverage) - Pay Amount
  const debtAmount = (parseFloat(payAmount || "0") * activeLeverage) - parseFloat(payAmount || "0");
  const formattedDebt = `${debtAmount.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${sellToken.symbol}`;

  // Liquidation Price Calculation
  // P_liq = (Entry_Price * (Leverage - 1)) / (Leverage * Liquidation_Threshold)
  const liquidationThreshold = 0.81;
  const liquidationPrice = activeLeverage > 1 
    ? (ethPrice * (activeLeverage - 1)) / (activeLeverage * liquidationThreshold)
    : 0;
  const getMoneynessRank = (symbol: string) => {
    if (["USDC", "USDT", "DAI"].includes(symbol)) return 0;
    if (symbol === "WBTC") return 1;
    if (symbol === "WETH") return 2;
    if (symbol === "GNO") return 3;
    return 4;
  };

  // Determine display price based on moneyness
  const sellRank = getMoneynessRank(sellToken.symbol);
  const buyRank = getMoneynessRank(buyToken.symbol);
  
  let displayLiquidationPrice = "";
  let displayLiquidationLabel = "Deleverage Price";

  // We want to express price of "Other" (Higher Rank Value) in terms of "More Money" (Lower Rank Value).
  // liquidationPrice variable is "Price of BuyToken in SellToken terms" (SellToken per BuyToken)
  
  if (sellRank < buyRank) {
    // Sell is "More Money" (e.g. USDC). Buy is "Other" (e.g. ETH).
    // We want Price of Other(Buy) in Money(Sell).
    // This is exactly what liquidationPrice represents (Sell per Buy).
    // e.g. 2800 USDC per 1 ETH.
    displayLiquidationPrice = `${liquidationPrice.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${sellToken.symbol}`;
    // Label could optionally indicate the "Other" token: "ETH Deleverage Price"
  } else if (buyRank < sellRank) {
    // Buy is "More Money" (e.g. USDC). Sell is "Other" (e.g. ETH).
    // liquidationPrice is "Sell per Buy" (e.g. 0.0003 ETH per USDC).
    // We want Price of Other(Sell) in Money(Buy).
    // This is 1 / liquidationPrice (e.g. 3000 USDC per ETH).
    const invPrice = liquidationPrice > 0 ? 1 / liquidationPrice : 0;
    displayLiquidationPrice = `${invPrice.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${buyToken.symbol}`;
  } else {
    // Equal moneyness (e.g. USDC vs USDT). Default to standard (Sell per Buy).
    displayLiquidationPrice = `${liquidationPrice.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${sellToken.symbol}`;
  }

  const formattedLiquidationPrice = displayLiquidationPrice;
  const liquidationDrop = activeLeverage > 1 ? ((ethPrice - liquidationPrice) / ethPrice) * 100 : 0;


  const handleTokenSelect = (token: Token) => {
    if (selectingSide === 'sell') {
      if (token.symbol === buyToken.symbol) {
        setBuyToken(sellToken); // Swap if same
      }
      setSellToken(token);
    } else {
      if (token.symbol === sellToken.symbol) {
        setSellToken(buyToken); // Swap if same
      }
      setBuyToken(token);
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
              <div className="bg-[#0b0e1e] rounded-2xl p-4 transition-colors hover:bg-[#0b0e1e]/80 group">
                <div className="flex justify-between mb-2">
                    <label className="text-muted-foreground text-sm font-medium">Sell</label>
                    <span className="text-muted-foreground text-sm">Balance: 0 {sellToken.symbol}</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <Input 
                    type="number" 
                    value={payAmount}
                    onChange={(e) => setPayAmount(e.target.value)}
                    className="border-0 bg-transparent text-4xl font-normal p-0 h-auto focus-visible:ring-0 placeholder:text-muted-foreground/50 w-full"
                    placeholder="0"
                  />
                  <Button 
                    variant="secondary" 
                    className="rounded-full h-10 px-3 bg-secondary hover:bg-secondary/80 flex items-center gap-2 min-w-fit"
                    onClick={() => openTokenSelect('sell')}
                  >
                    <div className="w-6 h-6 rounded-full bg-white flex items-center justify-center p-0.5 overflow-hidden">
                         <img src={sellToken.icon} alt={sellToken.symbol} className="w-full h-full object-contain" />
                    </div>
                    <span className="text-lg font-medium text-white">{sellToken.symbol}</span>
                    <ChevronDown className="h-4 w-4 opacity-50" />
                  </Button>
                </div>
                <div className="text-muted-foreground text-sm mt-2">
                    ≈ ${(parseFloat(payAmount || "0") * sellToken.price).toFixed(2)}
                </div>
              </div>

              {/* Arrow Connector */}
              <div className="relative h-2 z-10">
                <div className="absolute left-1/2 -translate-x-1/2 -top-4">
                    <div className="bg-[#12152b] p-1.5 rounded-xl border-4 border-[#12152b]">
                        <div 
                            className="bg-secondary/50 p-1.5 rounded-lg hover:bg-secondary transition-colors cursor-pointer"
                            onClick={() => {
                                const temp = sellToken;
                                setSellToken(buyToken);
                                setBuyToken(temp);
                            }}
                        >
                            <ArrowDown className="h-4 w-4 text-foreground" />
                        </div>
                    </div>
                </div>
              </div>

              {/* Buy Section */}
              <div className="bg-[#0b0e1e] rounded-2xl p-4 pt-6 transition-colors hover:bg-[#0b0e1e]/80 relative">
                <div className="flex justify-between mb-2">
                    <div className="flex items-center gap-2">
                        <label className="text-muted-foreground text-sm font-medium">Buy</label>
                        {!showLeverage && (
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
                     {activeLeverage > 1 && (
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
                                        (-{liquidationDrop.toFixed(2)}%)
                                    </span>
                                </span>
                            </div>
                        </div>
                     )}
                </div>

                {/* LEVERAGE OVERLAY - Compact & High */}
                {showLeverage && (
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
                                        setLeverage([1]);
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
                 <div className="flex justify-between items-center text-sm text-muted-foreground hover:text-foreground/80 transition-colors cursor-pointer group">
                    <div className="flex items-center gap-1">
                        <span>1 {buyToken.symbol} = {ethPrice.toFixed(4)} {sellToken.symbol}</span>
                    </div>
                    <div className="flex items-center gap-1 text-xs">
                        <span className="text-foreground">~$4.50</span>
                        <ChevronDown className="h-3 w-3" />
                    </div>
                 </div>
              </div>

              <Button 
                onClick={() => setIsConfirmOpen(true)}
                className="w-full h-14 text-lg font-semibold rounded-2xl bg-primary hover:bg-primary/90 shadow-[0_0_20px_rgba(76,130,251,0.3)] mt-2 transition-all"
              >
                {activeLeverage > 1 ? `Swap with ${activeLeverage}x Leverage` : 'Swap'}
              </Button>

              {activeLeverage > 1 && (
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
            sellToken={sellToken}
            buyToken={buyToken}
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
                        {filteredTokens.map((token) => (
                            <button
                                key={token.symbol}
                                onClick={() => handleTokenSelect(token)}
                                className={`w-full flex items-center justify-between p-2 rounded-lg hover:bg-white/5 transition-colors ${
                                    (selectingSide === 'sell' && sellToken.symbol === token.symbol) || 
                                    (selectingSide === 'buy' && buyToken.symbol === token.symbol) 
                                        ? 'opacity-50 cursor-default' 
                                        : ''
                                }`}
                                disabled={
                                    (selectingSide === 'sell' && sellToken.symbol === token.symbol) || 
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
                                {(selectingSide === 'sell' && sellToken.symbol === token.symbol) || 
                                 (selectingSide === 'buy' && buyToken.symbol === token.symbol) && (
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
