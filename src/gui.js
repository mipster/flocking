export function addSpeciesFolders(gui, species) {
  for (const s of species) {
    const f = gui.addFolder(s.name);
    f.addColor(s, 'color');
    f.add(s, 'scale', 0.3, 12, 0.1).name('body size');
    f.add(s, 'maxSpeed', 1, 40, 0.5);
    f.add(s, 'maxForce', 1, 100, 0.5);
    f.add(s, 'sepRadius', 0, 30, 0.1);
    f.add(s, 'aliRadius', 0, 40, 0.1);
    f.add(s, 'cohRadius', 0, 50, 0.1);
    f.add(s, 'sepWeight', 0, 5, 0.05);
    f.add(s, 'aliWeight', 0, 5, 0.05);
    f.add(s, 'cohWeight', 0, 5, 0.05);
    f.add(s, 'fearRadius', 0, 50, 0.5);
    f.add(s, 'fearWeight', 0, 8, 0.05);
    f.add(s, 'huntRadius', 0, 60, 0.5);
    f.add(s, 'huntWeight', 0, 3, 0.05);
    f.add(s, 'wander', 0, 1, 0.01);
    f.add(s, 'glint', 0, 3, 0.05).name('glint (sun sparkle)');
    f.close();
  }
}
