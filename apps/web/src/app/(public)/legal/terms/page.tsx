import { permanentRedirect } from "next/navigation";

/** The terms of service were for a hosted service, which there no longer is. The license is what applies now. */
export default function TermsPage() {
  permanentRedirect("/legal/license");
}
