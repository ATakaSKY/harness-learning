import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// shadcn/prompt-kit's className helper: merge conditional + conflicting classes.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
