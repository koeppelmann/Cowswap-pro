# CoW Swap Leverage UI Prototype

A React-based front-end prototype demonstrating a CoW Swap-style decentralized exchange interface with integrated leverage trading functionality. 

This project explores how intent-based swapping interfaces (like CoW Swap) can be extended to support advanced trading features such as opening and managing leveraged positions directly from the swap interface.

## Features

- **Token Swapping:** Standard token swap interface supporting mock assets (USDC, WETH, WBTC, GNO, DAI).
- **Leveraged Trading:** Seamlessly open leveraged positions (up to 5x) directly from the swap UI.
- **Position Management:** 
  - View active positions in the token selector.
  - Adjust leverage on existing positions via a dedicated slider.
  - Close or partially reduce positions using an intuitive percentage-based input (with 25%, 50%, 75%, and Max shortcuts).
- **Advanced Metrics:** Displays mock liquidation prices, debt amounts, and dynamic quotes based on user input and leverage selection.
- **Polished UI:** Matches the clean, user-friendly aesthetics of modern decentralized exchanges, featuring interactive dialogs, tooltips, and responsive design.

## Tech Stack

- **Framework:** React 18 with Vite
- **Styling:** Tailwind CSS
- **Components:** shadcn/ui
- **Icons:** Lucide React
- **Routing:** Wouter

## Getting Started

To run this project locally:

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the development server:
   ```bash
   npm run dev
   ```

3. Open your browser and navigate to the local port provided in the terminal (usually `http://localhost:5000`).

## Notes
This is a **frontend-only prototype/mockup**. It does not interact with real smart contracts, backend servers, or actual blockchain networks. All prices, positions, and trades are stored in local component state for demonstration purposes.
