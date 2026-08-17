"use client";

import { CatalogView } from "@/components/CatalogView";

// The one catalog route. Which half of it is shown (一般 / 成人) is the stored
// mode, read straight from ModeContext by CatalogView.
export default function Home() {
  return <CatalogView />;
}
