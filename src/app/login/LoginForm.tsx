"use client";

import { useState } from "react";

/**
 * The submit is a real form POST that ends in a 303, so the browser navigates
 * away and this component is torn down — nothing has to clear the pending
 * state. What it does have to survive is the round trip: the request reaches
 * Vercel, opens a pooled Postgres connection and comes back, which is close to
 * a second cold. Without feedback that reads as a dead button, and the usual
 * response is to click it again.
 */
export function LoginForm({ from }: { from: string }) {
  const [pending, setPending] = useState(false);

  return (
    <form
      action="/api/auth/session"
      method="POST"
      onSubmit={() => setPending(true)}
      className="mt-6 flex flex-col gap-3"
    >
      <input type="hidden" name="from" value={from} />
      {/*
        readOnly, never disabled. A disabled control is omitted from the form
        data entirely, and setting pending on submit re-renders this input
        before the browser has serialised the form — so the passphrase arrived
        empty and every correct password was rejected. readOnly locks the field
        without removing it from the submission.
      */}
      <input
        type="password"
        name="passphrase"
        autoFocus
        autoComplete="current-password"
        readOnly={pending}
        className="rounded border border-black/20 dark:border-white/25 bg-transparent px-3 py-2 text-sm read-only:opacity-50"
        placeholder="Passphrase"
      />
      <button
        type="submit"
        disabled={pending}
        className="flex items-center justify-center gap-2 rounded bg-black px-3 py-2 text-sm text-white transition-opacity disabled:opacity-70 dark:bg-white dark:text-black"
      >
        {pending ? (
          <>
            {/* aria-hidden: the button's own text already announces the state,
                so exposing the spinner too would have it read twice. */}
            <svg
              aria-hidden="true"
              className="size-4 animate-spin"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="3"
                className="opacity-25"
              />
              <path
                d="M12 2a10 10 0 0 1 10 10"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
              />
            </svg>
            Signing in…
          </>
        ) : (
          "Sign in"
        )}
      </button>
    </form>
  );
}
