import { GoalsClient } from "@/components/goals/GoalsClient";

export const metadata = { title: "Goals — JARVIS OS" };

export default function GoalsPage() {
  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <div className="mb-5">
        <h1 className="font-display text-2xl font-semibold text-text-primary">Goals</h1>
        <p className="text-text-secondary text-sm mt-1">Track what matters. JARVIS monitors your progress.</p>
      </div>
      <GoalsClient />
    </div>
  );
}
