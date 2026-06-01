/** A label/value row inside the bordered setting cards in the 同步 tab. */
export function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <span className="text-sm">{label}</span>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
