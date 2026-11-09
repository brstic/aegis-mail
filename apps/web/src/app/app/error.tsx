"use client"; // Error boundaries must be Client Components
import { AlertTriangle } from "lucide-react";
import { useEffect } from "react";
import { Button, EmptyState } from "@/components/ui";

/**
 * One screen failing shouldn't take the sidebar and navigation with it. This wraps every page under /app, inside the
 * shell, so the rest of the app stays usable and the screen can be tried again.
 */
export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <div className="p-6">
      <EmptyState icon={AlertTriangle} title="This screen didn't load" action={<Button onClick={() => retry()}>Try again</Button>}>
        Something went wrong showing it. Your mail and settings aren&apos;t affected, and the rest of the app still works.
      </EmptyState>
    </div>
  );
}
