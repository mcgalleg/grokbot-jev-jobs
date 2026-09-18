'use client';

import { Button } from '@/components/ui/button';

export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">The list failed to load</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        A dashboard refresh failed. Apply write-backs are still recorded; try again without
        reloading the tab.
        {error.digest ? ` (${error.digest})` : ''}
      </p>
      <Button type="button" className="mt-4" onClick={() => retry()}>
        Try again
      </Button>
    </main>
  );
}
