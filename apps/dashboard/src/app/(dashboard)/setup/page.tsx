import { getSession } from "@/lib/session";
import { PageHeader } from "@/components/ui";
import { SetupSteps } from "@/components/SetupSteps";

export default async function SetupPage() {
  const session = await getSession();
  const email = session?.user?.email ?? "you@company.com";

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Set up BurnWatch on your laptop"
        subtitle="Five minutes, once. After that the agent reports yesterday's usage every evening on its own."
      />

      {/* The commands differ per OS, and the switch has to drive four separate
          steps at once, so the whole body is one client component rather than
          three copies of the page. */}
      <SetupSteps email={email} />
    </div>
  );
}
