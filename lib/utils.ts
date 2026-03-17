import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}


export class BoundedSet<T> {
  private maxSize: number;
  private map: Map<T, null>;

  constructor(maxSize: number = 100) {
    this.maxSize = maxSize;
    this.map = new Map();
  }

  add(value: T) {
    // If exists, delete to refresh insertion order
    if (this.map.has(value)) this.map.delete(value);
    this.map.set(value, null);

    // Evict oldest if over maxSize
    if (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest!);
    }
  }

  has(value: T) {
    return this.map.has(value);
  }

  clear() {
    this.map.clear();
  }
}