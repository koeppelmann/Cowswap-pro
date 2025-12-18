import { useState, useEffect } from "react";
import { Link } from "wouter";
import { Settings, ChevronDown, RefreshCw, Wallet, ArrowDown, Info, ExternalLink, X, TrendingUp } from "lucide-react";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import logo from "@assets/logo.svg";

export default function SwapPage() {
  const [payAmount, setPayAmount] = useState<string>("10000");
  const [leverage, setLeverage] = useState<number[]>([2]); // Default 2x
  const [showLeverage, setShowLeverage] = useState(false);
  const [ethPrice, setEthPrice] = useState(2823.35);
  
  // Calculate buy amount based on leverage
  // Normal amount = payAmount / ethPrice
  // Leveraged amount = (payAmount * leverage) / ethPrice
  
  const rawBuyAmount = parseFloat(payAmount || "0") / ethPrice;
  
  // If leverage is shown, we use the leverage multiplier. If not shown (but technically default is 2), 
  // we might want to reset to 1x when closed? Or persist? 
  // User asked: "hidden by default (but there should be some blinking option to open it, by default 2x)"
  // This implies when you open it, it starts at 2x. When closed, it's 1x (standard swap).
  
  const activeLeverage = showLeverage ? leverage[0] : 1;
  const leveragedBuyAmount = rawBuyAmount * activeLeverage;
  
  const formattedBuyAmount = leveragedBuyAmount.toFixed(4);
  const formattedUsdValue = (parseFloat(payAmount || "0") * activeLeverage).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  
  // Debt Calculation
  // Debt = Total Position Value - Collateral (Pay Amount)
  // Debt = (Pay Amount * Leverage) - Pay Amount
  const debtAmount = (parseFloat(payAmount || "0") * activeLeverage) - parseFloat(payAmount || "0");
  const formattedDebt = debtAmount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

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
                    <span className="text-muted-foreground text-sm">Balance: 0 USDC</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <Input 
                    type="number" 
                    value={payAmount}
                    onChange={(e) => setPayAmount(e.target.value)}
                    className="border-0 bg-transparent text-4xl font-normal p-0 h-auto focus-visible:ring-0 placeholder:text-muted-foreground/50 w-full"
                    placeholder="0"
                  />
                  <Button variant="secondary" className="rounded-full h-10 px-3 bg-secondary hover:bg-secondary/80 flex items-center gap-2 min-w-fit">
                    <div className="w-6 h-6 rounded-full bg-[#2775CA] flex items-center justify-center text-[10px] text-white font-bold">
                        $
                    </div>
                    <span className="text-lg font-medium text-white">USDC</span>
                    <ChevronDown className="h-4 w-4 opacity-50" />
                  </Button>
                </div>
                <div className="text-muted-foreground text-sm mt-2">
                    ≈ ${parseFloat(payAmount || "0").toFixed(2)}
                </div>
              </div>

              {/* Arrow Connector */}
              <div className="relative h-2 z-10">
                <div className="absolute left-1/2 -translate-x-1/2 -top-4">
                    <div className="bg-[#12152b] p-1.5 rounded-xl border-4 border-[#12152b]">
                        <div className="bg-secondary/50 p-1.5 rounded-lg hover:bg-secondary transition-colors cursor-pointer">
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
                                    setLeverage([2]); // Default to 2x when opened
                                }}
                                className="group relative flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-primary/10 hover:bg-primary/20 transition-all border border-primary/20 hover:border-primary/50 animate-pulse hover:animate-none"
                            >
                                <TrendingUp className="w-3 h-3 text-primary" />
                                <span className="text-[10px] font-bold text-primary">Add Leverage</span>
                            </button>
                        )}
                    </div>
                    <span className="text-muted-foreground text-sm">Balance: 0 WETH</span>
                </div>
                
                <div className="flex items-center justify-between gap-4">
                  <Input 
                    readOnly
                    value={formattedBuyAmount}
                    className="border-0 bg-transparent text-4xl font-normal p-0 h-auto focus-visible:ring-0 text-primary w-full cursor-default"
                  />
                  <Button variant="secondary" className="rounded-full h-10 px-3 bg-secondary hover:bg-secondary/80 flex items-center gap-2 min-w-fit">
                    <div className="w-6 h-6 rounded-full bg-white flex items-center justify-center overflow-hidden p-0.5">
                        <img src="https://cryptologos.cc/logos/ethereum-eth-logo.svg?v=026" alt="ETH" className="w-full h-full object-contain" />
                    </div>
                    <span className="text-lg font-medium text-white">WETH</span>
                    <ChevronDown className="h-4 w-4 opacity-50" />
                  </Button>
                </div>
                
                <div className="flex flex-col gap-1 mt-2">
                     <div className="flex items-center gap-2">
                        <span className="text-green-400 text-sm">≈ {formattedUsdValue}</span>
                     </div>
                     {showLeverage && (
                        <div className="flex items-center gap-2 animate-in fade-in slide-in-from-top-1 duration-200">
                            <span className="text-xs text-muted-foreground">Debt:</span>
                            <span className="text-xs font-mono font-medium text-orange-400">{formattedDebt}</span>
                        </div>
                     )}
                </div>

                {/* LEVERAGE OVERLAY - Compact & High */}
                {showLeverage && (
                    <div className="absolute top-1 left-2 right-2 z-20">
                        <div className="bg-[#1a1d3d]/95 backdrop-blur-md border border-primary/20 rounded-xl shadow-lg p-3 animate-in fade-in slide-in-from-bottom-2 duration-200">
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
                        <span>1 WETH = {ethPrice.toFixed(2)} USDC</span>
                    </div>
                    <div className="flex items-center gap-1 text-xs">
                        <span className="text-foreground">~$4.50</span>
                        <ChevronDown className="h-3 w-3" />
                    </div>
                 </div>
              </div>

              <Button className="w-full h-14 text-lg font-semibold rounded-2xl bg-primary hover:bg-primary/90 shadow-[0_0_20px_rgba(76,130,251,0.3)] mt-2 transition-all">
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
      </main>
    </div>
  );
}
