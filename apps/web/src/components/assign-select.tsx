"use client";

/** A project picker that saves as soon as a choice is made. */
export function AssignSelect({
  action,
  hidden,
  projects,
  value,
  label,
}: {
  action: (formData: FormData) => void;
  hidden: Record<string, string | number>;
  projects: { id: string; name: string }[];
  value: string;
  label: string;
}) {
  return (
    <form action={action}>
      {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <select
        className="input w-44 py-1 text-xs"
        name="projectId"
        defaultValue={value}
        aria-label={label}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
      >
        <option value="">Unsorted</option>
        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </form>
  );
}
