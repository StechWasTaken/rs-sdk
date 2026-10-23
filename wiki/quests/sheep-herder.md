# Sheep Herder

## Overview

| Detail       | Info    |
|--------------|---------|
| Difficulty   | Novice  |
| Length       | Short   |
| Quest Points | 4       |

## Requirements

No skill or quest requirements.

## Items Needed

- 100 gp (to purchase plague suit)

## Rewards

- 3,100 gp

## Walkthrough

### Getting Started

Speak to Councillor Halgrive (2617, 3299), south of the Ardougne chapel ("What's wrong?", "I can do that for you."). Doctor Orbon is at (2614, 3306). He explains that 4 infected sheep have escaped quarantine and need to be dealt with before the plague spreads.

### Preparing Equipment

1. Receive poisoned sheep feed from Councillor Halgrive.
2. Visit Doctor Orbon near the chapel. Purchase a plague suit for 100 gp. You must wear the full plague suit to handle the infected sheep.
3. Pick up the **prod** (the cattle prod) lying in the pen by Farmer Brumty, at (2604, 3357): the pen gate lets you in with the suit on.

### Herding the Sheep

1. Wear the plague jacket and trousers and **wield** the cattle prod (using the prod on a sheep does nothing).
2. The 4 sheep, **Diseased sheep 1-4**, start near (2609, 3344), (2621, 3367), (2560, 3389) and (2610, 3391), north of Ardougne.
3. **Prod** moves a sheep **one tile straight away from you**, and you can only prod it from a side, not a corner: stand on the tile right behind it, opposite where it should go. It can't be pushed through a fence, and 10-30 ticks after a prod it wanders back towards where it started, so keep prodding.
4. The pen is the fenced field x 2595-2609, z 3351-3364. A sheep **prodded while it stands** on the tiles outside the west gate (x 2592-2594, z 3360-3363) jumps over the gate into the pen: push it onto them, then prod it once more. The way there goes round the fences: sheep 1 up the strip at x 2613 and west along z 3365; sheep 2 west along z 3367.
5. In code, `herd(/diseased sheep 1/i, { x1: 2592, z1: 3360, x2: 2594, z2: 3363 })` does all of this up to the gate tiles: it plans the pushes round the fences and prods from the right tile each time (30-60 pushes a sheep). Then `bot.interactNpc(sheep, 'Prod')` once more: "The sheep obligingly jumps over the gate and into the enclosure."

### Disposing of the Sheep

1. Use the poisoned feed on each sheep **in the pen** (outside it, the game won't let you).
2. Collect the bones from the sheep.
3. Burn the bones in the nearby furnace to prevent further contamination.

### Completing the Quest

Return to Councillor Halgrive and report that the infected sheep have been disposed of.

## Key NPCs & Locations

| NPC/Location          | Role                                      |
|-----------------------|-------------------------------------------|
| Councillor Halgrive   | Quest start, S of Ardougne chapel         |
| Doctor Orbon          | Sells plague suit (100 gp)                |
| Shed                  | Contains cattle prod                      |
| Sheep pen             | Herd infected sheep here                  |
| Furnace               | Burn sheep bones                          |
