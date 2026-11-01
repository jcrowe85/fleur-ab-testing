/**
 * The switch between the two things this app reports on.
 *
 * They are different kinds of question and they do not belong in one list.
 * A split test randomises shoppers between two arms of one page and exists to
 * decide something, so it carries a stopping rule and a confidence interval.
 * The Black Friday models are three separate pages with traffic aimed at them
 * from the ad account — nobody was randomised, nothing is balanced, and there
 * is no winner to call. Putting the models in among the test keys made the
 * tab for them read as a fourth experiment, which is the one thing it is not.
 *
 * So: two views, named for what they answer, and the test keys stay where
 * they are as a second row under whichever view owns them.
 */

const TABS = [
  { id: "tests", href: "/", label: "A/B tests", sub: "randomised, one page" },
  { id: "models", href: "/versions", label: "Black Friday models", sub: "three pages, aimed traffic" },
] as const;

export type ViewId = (typeof TABS)[number]["id"];

export function ViewTabs({ active }: { active: ViewId }) {
  return (
    <nav
      aria-label="Report"
      className="inline-flex rounded-lg border border-black/15 dark:border-white/20 p-1 gap-1"
    >
      {TABS.map((t) => {
        const on = t.id === active;
        return (
          <a
            key={t.id}
            href={t.href}
            aria-current={on ? "page" : undefined}
            title={t.sub}
            className={`rounded-md px-3 py-1.5 text-sm transition ${
              on
                ? "bg-black/8 dark:bg-white/15 font-medium"
                : "opacity-60 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/10"
            }`}
          >
            {t.label}
          </a>
        );
      })}
    </nav>
  );
}
