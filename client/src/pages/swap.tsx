import { useState, useEffect } from "react";
import { Link } from "wouter";
import { Settings, ChevronDown, RefreshCw, Wallet, ArrowDown, Info, ExternalLink, X, TrendingUp, AlertTriangle, Maximize2 } from "lucide-react";
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
  const [payAmount, setPayAmount] = useState<string>("100000");
  const [leverage, setLeverage] = useState<number[]>([2]); // Default 2x
  const [showLeverage, setShowLeverage] = useState(false);
  const [ethPrice, setEthPrice] = useState(2823.35);
  
  const rawBuyAmount = parseFloat(payAmount || "0") / ethPrice;
  const activeLeverage = showLeverage ? leverage[0] : 1;
  const leveragedBuyAmount = rawBuyAmount * activeLeverage;
  
  const formattedBuyAmount = leveragedBuyAmount.toFixed(4);
  const formattedUsdValue = (parseFloat(payAmount || "0") * activeLeverage).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  
  const debtAmount = (parseFloat(payAmount || "0") * activeLeverage) - parseFloat(payAmount || "0");
  const formattedDebt = debtAmount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  const liquidationThreshold = 0.81;
  const liquidationPrice = activeLeverage > 1 
    ? (ethPrice * (activeLeverage - 1)) / (activeLeverage * liquidationThreshold)
    : 0;
  const formattedLiquidationPrice = liquidationPrice.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const liquidationDrop = activeLeverage > 1 ? ((ethPrice - liquidationPrice) / ethPrice) * 100 : 0;

  return (
    <div className="min-h-screen bg-[#060a16] text-foreground flex flex-col font-sans">
      {/* Navbar - Simplified and aligned */}
      <header className="flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-8">
          <div className="flex items-center gap-2">
            <img src={logo} alt="CowSwap" className="w-8 h-8" />
            <span className="text-xl font-bold tracking-tight text-white hidden sm:block">CoW Swap</span>
          </div>
          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-gray-400">
            <a href="#" className="text-white">Swap</a>
            <a href="#" className="hover:text-primary transition-colors">Limit</a>
            <a href="#" className="hover:text-primary transition-colors">TWAP</a>
            <a href="#" className="hover:text-primary transition-colors">Yield</a>
          </nav>
        </div>
        <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-2 bg-[#1e223a] px-3 py-2 rounded-xl text-sm font-medium">
                <span className="w-2 h-2 rounded-full bg-blue-500"></span>
                <span>Ethereum</span>
                <ChevronDown className="w-4 h-4 text-gray-400" />
            </div>
            <Button variant="ghost" size="icon" className="text-gray-400 hover:text-white hover:bg-white/5">
                <Settings className="w-5 h-5" />
            </Button>
            <Button className="bg-[#59dcfc] hover:bg-[#4bcceb] text-black font-semibold rounded-xl px-5 py-2.5 h-auto text-sm transition-colors">
                Connect Wallet
            </Button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col items-center justify-center p-4 relative overflow-hidden">
        
        {/* Subtle Background Elements */}
        <div className="absolute inset-0 pointer-events-none opacity-20">
            <div className="absolute top-1/4 left-1/4 w-1 h-1 bg-white rounded-full opacity-50"></div>
            <div className="absolute top-1/3 left-2/3 w-1.5 h-1.5 bg-blue-400 rounded-full blur-[1px] opacity-40"></div>
            <div className="absolute bottom-1/4 right-1/4 w-1 h-1 bg-white rounded-full opacity-30"></div>
        </div>

        <div className="w-full max-w-[480px] space-y-4 relative z-10">
          
          {/* Top Controls Row */}
          <div className="flex items-center justify-between mb-2 px-2">
            <div className="flex items-center gap-2 bg-[#12152b] p-1 rounded-2xl border border-white/5">
               <button className="px-4 py-2 bg-[#2c304e] rounded-xl text-sm font-semibold text-white shadow-sm transition-all">Swap</button>
               <button className="px-4 py-2 text-sm font-medium text-gray-400 hover:text-white transition-colors">Limit<span className="text-primary ml-0.5">•</span></button>
               <button className="px-4 py-2 text-sm font-medium text-gray-400 hover:text-white transition-colors">TWAP</button>
            </div>
            <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" className="h-9 w-9 text-gray-400 hover:text-white hover:bg-white/5 rounded-xl">
                    <RefreshCw className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" className="h-9 w-9 text-gray-400 hover:text-white hover:bg-white/5 rounded-xl">
                    <Settings className="h-4 w-4" />
                </Button>
            </div>
          </div>

          <Card className="border-0 bg-[#12152b] shadow-2xl rounded-3xl overflow-visible ring-1 ring-white/5">
            <CardContent className="p-2 space-y-1">
              
              {/* Sell Section */}
              <div className="bg-[#0b0e1e] rounded-[20px] p-5 transition-colors hover:bg-[#0b0e1e]/80 group relative z-0">
                <div className="flex justify-between items-start mb-4 h-[72px]">
                    <div className="flex flex-col justify-center h-full w-full mr-4">
                        <Input 
                            type="number" 
                            value={payAmount}
                            onChange={(e) => setPayAmount(e.target.value)}
                            className="border-0 bg-transparent text-[40px] leading-tight font-medium p-0 h-auto focus-visible:ring-0 placeholder:text-gray-600 w-full text-white"
                            placeholder="0"
                        />
                        <div className="text-gray-500 text-sm font-medium mt-1">
                            ≈ ${parseFloat(payAmount || "0").toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}
                        </div>
                    </div>
                    <div className="flex flex-col items-end gap-3 min-w-fit">
                        <Button variant="secondary" className="rounded-full h-10 pl-2 pr-3 bg-[#2c304e] hover:bg-[#363b5f] flex items-center gap-2 min-w-fit border border-transparent hover:border-white/10 transition-all">
                            <div className="w-6 h-6 rounded-full bg-[#26A17B] flex items-center justify-center text-[10px] text-white font-bold p-0.5">
                                <span className="font-bold">T</span>
                            </div>
                            <span className="text-lg font-semibold text-white">USDT</span>
                            <ChevronDown className="h-5 w-5 text-gray-400" />
                        </Button>
                        <div className="flex items-center gap-2 text-gray-400 text-sm">
                             <span className="text-xs">500,000 USDT</span>
                             <button className="text-[10px] font-bold bg-[#1e223a] hover:bg-[#2c304e] px-1.5 py-0.5 rounded text-primary transition-colors uppercase">
                                MAX
                             </button>
                        </div>
                    </div>
                </div>
              </div>

              {/* Arrow Connector */}
              <div className="relative h-1 z-10">
                <div className="absolute left-1/2 -translate-x-1/2 -top-5">
                    <div className="bg-[#12152b] p-1.5 rounded-xl">
                        <div className="bg-[#2c304e] p-2 rounded-lg hover:bg-[#363b5f] transition-colors cursor-pointer border-4 border-[#12152b]">
                            <ArrowDown className="h-4 w-4 text-white" />
                        </div>
                    </div>
                </div>
              </div>

              {/* Buy Section */}
              <div className="bg-[#0b0e1e] rounded-[20px] p-5 pt-6 transition-colors hover:bg-[#0b0e1e]/80 relative group z-0">
                
                {/* Leverage Button Positioned Absolutely */}
                {!showLeverage && (
                    <div className="absolute top-4 left-5 z-20">
                         <button 
                            onClick={() => {
                                setShowLeverage(true);
                                setLeverage([2]);
                            }}
                            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#1a1d3d] hover:bg-[#2c304e] transition-all border border-primary/20 hover:border-primary/50 text-primary group-hover:opacity-100 opacity-80"
                        >
                            <TrendingUp className="w-3 h-3" />
                            <span className="text-[10px] font-bold uppercase tracking-wide">Leverage</span>
                        </button>
                    </div>
                )}

                <div className="flex justify-between items-start mb-4 h-[72px] mt-2">
                     <div className="flex flex-col justify-center h-full w-full mr-4">
                        <Input 
                            readOnly
                            value={formattedBuyAmount}
                            className="border-0 bg-transparent text-[40px] leading-tight font-medium p-0 h-auto focus-visible:ring-0 text-white w-full cursor-default"
                        />
                         <div className="flex items-center gap-2 mt-1">
                             <div className="text-green-400 text-sm font-medium">≈ {formattedUsdValue}</div>
                             <span className="text-red-400 text-xs font-medium">(-2.18%)</span>
                         </div>
                     </div>

                    <div className="flex flex-col items-end gap-3 min-w-fit">
                        <Button variant="secondary" className="rounded-full h-10 pl-2 pr-3 bg-[#2c304e] hover:bg-[#363b5f] flex items-center gap-2 min-w-fit border border-transparent hover:border-white/10 transition-all">
                            <div className="w-6 h-6 rounded-full bg-[#F5D130] flex items-center justify-center p-0.5 overflow-hidden">
                                <span className="text-black font-bold text-[8px]">COW</span>
                            </div>
                            <span className="text-lg font-semibold text-white">COW</span>
                            <ChevronDown className="h-5 w-5 text-gray-400" />
                        </Button>
                         <div className="flex items-center gap-2 text-gray-400 text-sm">
                             <span className="text-xs">9,056,227.19 COW</span>
                        </div>
                    </div>
                </div>

                {/* Leverage Info Row (Only visible when leverage is active) */}
                {showLeverage && (
                    <div className="mt-4 pt-3 border-t border-white/5 flex items-center justify-between text-xs animate-in fade-in slide-in-from-top-1 duration-200">
                         <div className="flex items-center gap-4">
                            <div className="flex flex-col gap-0.5">
                                <span className="text-gray-500 font-medium">Debt</span>
                                <span className="text-gray-300 font-mono font-medium">{formattedDebt}</span>
                            </div>
                            <div className="flex flex-col gap-0.5">
                                <span className="text-gray-500 font-medium">Liquidation</span>
                                <div className="flex items-center gap-1.5">
                                    <span className="text-gray-300 font-mono font-medium">{formattedLiquidationPrice}</span>
                                    <span className="text-gray-500">(-{liquidationDrop.toFixed(2)}%)</span>
                                </div>
                            </div>
                         </div>
                    </div>
                )}

                {/* LEVERAGE OVERLAY - Integrated Style */}
                {showLeverage && (
                    <div className="absolute -top-3 left-4 right-4 z-30">
                        <div className="bg-[#1a1d3d] border border-primary/20 rounded-xl shadow-[0_4px_20px_-4px_rgba(0,0,0,0.5)] p-2.5 animate-in fade-in slide-in-from-bottom-2 duration-200 flex items-center gap-3">
                            <div className="flex flex-col gap-0.5 min-w-[50px] pl-1">
                                <span className="text-[9px] text-gray-400 uppercase tracking-wider font-bold">Leverage</span>
                                <span className="text-[#59dcfc] font-bold font-mono text-sm leading-none">
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
                                className="text-gray-400 hover:text-white transition-colors p-1.5 hover:bg-white/5 rounded-lg"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>
                    </div>
                )}

              </div>

              {/* Receive Row */}
              <div className="flex justify-between items-center px-4 py-3 mt-1">
                  <div className="flex items-center gap-1.5 text-sm font-medium text-gray-300">
                      <span>Receive (incl. fees)</span>
                      <Info className="w-3.5 h-3.5 text-gray-500" />
                  </div>
                  <span className="text-xl font-bold text-white tracking-tight">{parseFloat(formattedBuyAmount).toLocaleString('en-US', {maximumFractionDigits: 3})}</span>
              </div>
              
            </CardContent>
          </Card>
          
          {/* Rate & Gas Info */}
          <div className="flex justify-between items-center px-4 text-xs font-medium text-gray-400">
                <div className="flex items-center gap-1 cursor-pointer hover:text-white transition-colors">
                    <span>1 COW = 0.195447 USDT (≈ $0.2)</span>
                </div>
                <div className="flex items-center gap-1 cursor-pointer hover:text-white transition-colors">
                    <span>≈ $26.43</span>
                    <ChevronDown className="w-3 h-3" />
                </div>
          </div>
          
          {/* Warning Box */}
          <div className="bg-[#2a2723] rounded-2xl p-4 border border-[#4a4235] relative overflow-hidden">
               <div className="flex flex-col items-center text-center gap-2 relative z-10">
                   <div className="w-8 h-8 rounded-full bg-[#F5D130]/20 flex items-center justify-center mb-1">
                        <AlertTriangle className="w-5 h-5 text-[#F5D130]" fill="#F5D130" />
                   </div>
                   <h3 className="text-[#F5D130] font-bold text-sm">Minimize price impact with TWAP</h3>
                   <p className="text-[#F5D130]/90 text-xs leading-relaxed max-w-[90%]">
                       The price impact is <span className="font-bold">2.18%</span>. Consider breaking up your order using a <span className="underline cursor-pointer hover:text-white decoration-[#F5D130]/50 underline-offset-2">TWAP order</span> and possibly get a better rate.
                   </p>
               </div>
          </div>

          <Button className="w-full h-14 text-lg font-bold rounded-2xl bg-[#59dcfc] hover:bg-[#4bcceb] text-[#060a16] shadow-lg mt-2 transition-all">
            {activeLeverage > 1 ? `Swap with ${activeLeverage}x Leverage` : 'Swap'}
          </Button>

        </div>
      </main>
    </div>
  );
}
