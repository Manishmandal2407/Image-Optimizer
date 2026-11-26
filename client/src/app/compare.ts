import { Component, input, signal } from '@angular/core';

// A before/after slider: drag to reveal the original on the left
// and the smaller copy on the right.
@Component({
  selector: 'app-compare',
  templateUrl: './compare.html',
  styleUrl: './compare.css',
})
export class Compare {
  original = input.required<string>();
  smaller = input.required<string>();
  originalLabel = input('Original');
  smallerLabel = input('Smaller copy');

  // Where the divider is, from 0 to 100 (in %).
  pos = signal(50);

  move(event: Event) {
    this.pos.set(Number((event.target as HTMLInputElement).value));
  }
}
