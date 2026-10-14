import GUI from 'lil-gui';

export function createGui(settings, species, actions) {
  const gui = new GUI({ title: 'Fish flock' });

  const g = gui.addFolder('Global');
  g.add(settings, 'size', { '32² (1k)': 32, '64² (4k)': 64, '128² (16k)': 128 })
    .name('fish count').onChange(actions.rebuild);
  g.add(settings, 'speed', 0, 3, 0.05).name('speed ×');
  g.add(settings, 'paused').name('pause');
  g.add(settings, 'showTank').name('show tank').onChange(actions.toggleTank);
  g.add(settings, 'fogDensity', 0, 0.03, 0.001).name('fog');
  g.add(settings, 'mediumCount', 0, 5000, 1).name('medium fish')
    .onFinishChange(actions.rebuild);
  g.add(settings, 'largeCount', 0, 500, 1).name('large fish')
    .onFinishChange(actions.rebuild);
  g.add(actions, 'rebuild').name('reset');
  // small fish are whatever remains: total - medium - large

  addSpeciesFolders(gui, species);
  return gui;
}

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
    f.close();
  }
}
