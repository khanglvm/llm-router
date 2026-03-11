import { cn } from "../../lib/utils.js";

export function Textarea({ className, ...props }) {
  return (
    <textarea
      className={cn(
        "flex min-h-40 w-full rounded-xl border border-input bg-background/80 px-3 py-3 text-sm text-foreground shadow-sm outline-none transition placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/40",
        className
      )}
      {...props}
    />
  );
}
