// The project's full suite. It uses a helper package the project never installed.
import { describeAll } from 'slug-suite-helpers'
import { slugify } from './slug.mjs'

describeAll({ slugify })
