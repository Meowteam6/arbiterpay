"use client";

// Dev/demo preview for THE DROP payout moment. Not linked anywhere; it renders
// the takeover with mock data so the moment can be reviewed without driving a
// full claim to settlement. Real payouts stay ledger-driven in the claim flow.
// Add ?tier=self to preview the self-reported branch.

import { useEffect, useState } from "react";
import PayoutMoment from "@/components/PayoutMoment";

export default function PayoutPreview() {
  const [selfReported, setSelfReported] = useState(false);
  const [initialOpen, setInitialOpen] = useState(true);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setSelfReported(params.get("tier") === "self");
    // ?view=receipt previews the left-behind receipt (takeover pre-dismissed).
    setInitialOpen(params.get("view") !== "receipt");
  }, []);

  return (
    <PayoutMoment
      paidUsd="50.00"
      txHash="0x1111111111111111111111111111111111111111111111111111111111111111"
      selfReported={selfReported}
      initialOpen={initialOpen}
    />
  );
}
