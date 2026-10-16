import { configFromEnv } from "../lib/config.js";
import { buildApp } from "../lib/app.js";

buildApp(configFromEnv()).app.synth();
