import { LoginForm } from "./LoginForm";

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

      <LoginForm from={from} />

      {error ? (
        <p className="mt-3 text-sm text-rose-600 dark:text-rose-400">Incorrect passphrase.</p>
      ) : null}
    </main>
  );
}
