import { redirect } from 'next/navigation';

// The leverage product merged into the main app's Swap tab (default tab on /).
// /leverage/architecture (the "how it works" page) remains.
export default function LeveragePage() {
  redirect('/');
}
