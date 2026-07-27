export const dynamic = "force-dynamic";

export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; error?: string }>;
}) {
  const { from = "/", error } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center p-8">
      <h1 className="text-lg font-semibold">Fleur A/B testing</h1>
      <p className="mt-1 text-sm opacity-60">Internal. Enter the dashboard passphrase.</p>

      <form action="/api/auth/session" method="POST" className="mt-6 flex flex-col gap-3">
        <input type="hidden" name="from" value={from} />
        <input
          type="password"
          name="passphrase"
          autoFocus
          autoComplete="current-password"
          className="rounded border border-black/20 dark:border-white/25 bg-transparent px-3 py-2 text-sm"
          placeholder="Passphrase"
        />
        <button
          type="submit"
          className="rounded bg-black px-3 py-2 text-sm text-white dark:bg-white dark:text-black"
        >
          Sign in
        </button>
      </form>

      {error ? <p className="mt-3 text-sm text-rose-600 dark:text-rose-400">Incorrect passphrase.</p> : null}
    </main>
  );
}
