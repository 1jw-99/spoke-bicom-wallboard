// Picks the data source. Add a MiRTA adapter here later: it only has to produce
// the same snapshot shape (see docs/ARCHITECTURE.md).
import { Pbxware7Source } from './pbxware7.js';
import { createMockClient } from './mock-client.js';

export function createSource(config) {
  switch (config.source) {
    case 'pbxware7':
      return new Pbxware7Source(config);
    case 'mock':
      return new Pbxware7Source(config, createMockClient(), { label: 'mock' });
    default:
      throw new Error(`Unknown source ${config.source}`);
  }
}
