import { NotesClient } from "@/components/notes/NotesClient";

export const metadata = { title: "Notes — JARVIS OS" };

export default function NotesPage() {
  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <div className="mb-5">
        <h1 className="font-display text-2xl font-semibold text-text-primary">Notes</h1>
        <p className="text-text-secondary text-sm mt-1">Quick capture. Ask JARVIS to "take a note about X" from the Assistant.</p>
      </div>
      <NotesClient />
    </div>
  );
}
