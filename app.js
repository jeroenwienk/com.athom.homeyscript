'use strict';

const fs = require('fs').promises;
const vm = require('vm');
const util = require('util');
const path = require('path');
const http = require('http');
const https = require('https');
const uuid = require('uuid');

const Homey = require('homey');
const { HomeyAPI } = require('athom-api');
const fetch = require('node-fetch');
const _ = require('lodash');

module.exports = class HomeyScriptApp extends Homey.App {

  static RUN_TIMEOUT = 1000 * 30; // 30s

  async onInit() {
    // Init Scripts
    this.scripts = this.homey.settings.get('scripts');

    this.localURL = await this.homey.api.getLocalUrl();
    this.sessionToken = await this.homey.api.getOwnerApiToken();

    if (!this.scripts) {
      this.log('No scripts found.');

      const scripts = {};

      // Copy example scripts
      try {
        const files = await fs.readdir(path.join(__dirname, 'examples'));
        await Promise.all(files.map(async filename => {
          if (!filename.endsWith('.js')) return;

          const id = `example-${filename.substring(0, filename.length - '.js'.length)}`;
          const filepath = path.join(__dirname, 'examples', filename);
          const code = await fs.readFile(filepath, 'utf8');

          scripts[id] = {
            code,
            lastExecuted: null,
          };

          this.log(`Found Example: ${id}`);
        }));
      } catch (err) {
        this.error('Examples Error:', err);
      }

      // Check for existing (SDK2) scripts in /userdata
      try {
        const files = await fs.readdir(path.join(__dirname, 'userdata', 'scripts'));
        await Promise.all(files.map(async filename => {
          if (!filename.endsWith('.js')) return;

          const id = filename.substring(0, filename.length - '.js'.length);
          const filepath = path.join(__dirname, 'userdata', 'scripts', filename);
          const code = await fs.readFile(filepath, 'utf8');

          scripts[id] = {
            code,
            lastExecuted: new Date(this.homey.settings.get(`last-execution-${id}`)),
          };

          this.log(`Found Migration: ${id}`);
        }));
      } catch (err) {
        this.error('Migration Error:', err);
      }

      this.scripts = scripts;
      this.homey.settings.set('scripts', this.scripts);
    }

    // Migration: Add missing `name` property
    if (this.scripts) {
      const scriptEntries = Object.entries(this.scripts);
      let anyScriptChanged = false;

      for (const [scriptId, script] of scriptEntries) {
        if (typeof script.name !== 'string') {
          anyScriptChanged = true;
          script.name = scriptId;
          script.id = scriptId;
        }
      }

      if (anyScriptChanged) {
        this.homey.settings.set('scripts', this.scripts);
      }
    }

    // Register Flow Cards
    this.homey.flow.getConditionCard('run')
      .registerRunListener(async ({ script }) => {
        const scriptSource = await this.getScript({ id: script.id });

        return this.runScript({
          id: scriptSource.id,
          name: scriptSource.name,
          code: scriptSource.code,
          lastExecuted: scriptSource.lastExecuted,
          realtime: false,
        }).finally(() => {
          this.updateScript({ id: scriptSource.id, lastExecuted: new Date() }).catch(this.error);
        });
      })
      .registerArgumentAutocompleteListener('script', query => this.onFlowGetScriptAutocomplete(query));

    this.homey.flow.getConditionCard('runWithArg')
      .registerRunListener(async ({ script, argument }) => {
        const scriptSource = await this.getScript({ id: script.id });

        return this.runScript({
          id: scriptSource.id,
          name: scriptSource.name,
          code: scriptSource.code,
          lastExecuted: scriptSource.lastExecuted,
          args: [argument],
          realtime: false,
        }).finally(() => {
          this.updateScript({ id: scriptSource.id, lastExecuted: new Date() }).catch(this.error);
        });
      })
      .registerArgumentAutocompleteListener('script', query => this.onFlowGetScriptAutocomplete(query));

    this.homey.flow.getActionCard('run')
      .registerRunListener(async ({ script }) => {
        const scriptSource = await this.getScript({ id: script.id });

        return this.runScript({
          id: scriptSource.id,
          name: scriptSource.name,
          code: scriptSource.code,
          lastExecuted: scriptSource.lastExecuted,
          realtime: false,
        }).finally(() => {
          this.updateScript({ id: scriptSource.id, lastExecuted: new Date() }).catch(this.error);
        });
      })
      .registerArgumentAutocompleteListener('script', query => this.onFlowGetScriptAutocomplete(query));

    this.homey.flow.getActionCard('runWithArg')
      .registerRunListener(async ({ script, argument }) => {
        const scriptSource = await this.getScript({ id: script.id });

        return this.runScript({
          id: scriptSource.id,
          name: scriptSource.name,
          code: scriptSource.code,
          lastExecuted: scriptSource.lastExecuted,
          args: [argument],
          realtime: false,
        }).finally(() => {
          this.updateScript({ id: scriptSource.id, lastExecuted: new Date() }).catch(this.error);
        });
      })
      .registerArgumentAutocompleteListener('script', query => this.onFlowGetScriptAutocomplete(query));

    // Register Flow Tokens
    this.tokens = this.homey.settings.get('tokens') || {};
    this.tokensInstances = {};

    await Promise.all(Object.keys(this.tokens).map(async id => {
      this.tokensInstances[id] = await this.homey.flow.createToken(id, {
        title: id,
        type: this.tokens[id].type,
        value: this.tokens[id].value,
      });
    })).catch(this.error);
  }

  async getHomeyAPI() {
    const api = new HomeyAPI({
      localUrl: this.localURL,
      baseUrl: this.localURL,
      token: this.sessionToken,
      apiVersion: 2,
      online: true,
    }, () => {
      // called by HomeyAPI on 401 requests
      api.setToken(this.sessionToken);
    });

    return api;
  }

  async onFlowGetScriptAutocomplete(query) {
    const scripts = await this.getScripts();
    return Object.values(scripts)
      .filter(script => script.name.toLowerCase().includes(query.toLowerCase()))
      .map(script => ({
        id: script.id,
        name: script.name,
      }));
  }

  async setToken({ id, value, type = typeof value }) {
    // Delete the Token
    if (typeof value === 'undefined' || value === null) {
      if (this.tokensInstances[id]) {
        await this.tokensInstances[id].unregister().catch(this.error);
      }

      if (this.tokens[id]) {
        delete this.tokens[id];
        delete this.tokensInstances[id];
        this.homey.settings.set('tokens', this.tokens);
      }

      return;
    }

    // Create the Token
    if (!this.tokensInstances[id]) {
      this.tokensInstances[id] = await this.homey.flow.createToken(id, {
        type,
        value,
        title: id,
      });

      this.tokens[id] = { type, value };
      this.homey.settings.set('tokens', this.tokens);

      return;
    }

    // Update the Token
    if (this.tokensInstances[id]) {
      await this.tokensInstances[id].setValue(value);

      this.tokens[id].value = value;
      this.homey.settings.set('tokens', this.tokens);
    }
  }

  async getScripts() {
    return this.scripts;
  }

  async getScript({ id }) {
    const script = this.scripts[id];

    if (!script) {
      throw new Error('Script Not Found');
    }

    return {
      ...script,
      lastExecuted: new Date(script.lastExecuted),
    };
  }

  async runScript({
    id,
    name,
    code,
    lastExecuted,
    args = [],
    realtime = true,
  }) {
    if (lastExecuted == null) lastExecuted = new Date();

    const homeyAPI = await this.getHomeyAPI();

    // Create a Logger
    const log = (...props) => {
      this.log(`[${name}]`, ...props);

      if (realtime) {
        this.homey.api.realtime('log', {
          text: util.format(...props),
          script: id,
        });
      }
    };

    // Create the Context
    const context = vm.createContext({
      args,

      // 3rd party modules
      _,
      fetch,
      http,
      https,
      URLSearchParams,
      Buffer,

      // System
      __filename__: `${name}.js`,
      __script_id__: id,
      __last_executed__: lastExecuted,
      __ms_since_last_executed__: Date.now() - lastExecuted.getTime(),

      // Homey API
      Homey: homeyAPI,

      // Logging
      log,
      console: {
        log,
        error: log,
        info: log,
      },

      // Shortcuts
      say: async text => homeyAPI.speechOutput.say({ text }),
      tag: async (id, value) => this.setToken({ id, value }),
      wait: async delay => new Promise(resolve => setTimeout(resolve, delay)),

      // Cross-Script Settings
      global: {
        get: key => this.homey.settings.get(`homeyscript-${key}`),
        set: (key, value) => this.homey.settings.set(`homeyscript-${key}`, value),
        keys: () => this.homey.settings.getKeys()
          .filter(key => key.startsWith('homeyscript-'))
          .map(key => key.substring('homeyscript-'.length)),
      },

      // Deprecated
      setTagValue: async (id, opts, value) => {
        log('Warning: setTagValue(id, opts, value) is deprecated, please use tag(id, value)');
        await this.setToken({
          id,
          value,
          type: opts.type,
        });
      },
    });

    try {
      // Create the Sandbox
      const sandbox = new vm.Script(`Promise.resolve().then(async () => {\n${code}\n});`, {
        filename: `${name}.js`,
        lineOffset: -1,
        columnOffset: 0,
      });

      const runPromise = sandbox.runInNewContext(context, {
        displayErrors: true,
        timeout: this.constructor.RUN_TIMEOUT,
        microtaskMode: 'afterEvaluate', // from Node 14 should properly timeout async script
      });

      const result = await runPromise;
      log('\n———————————————————\n✅ Script Success\n');
      log('↩️ Returned:', JSON.stringify(result, false, 2));
      return result;
    } catch (err) {
      log('\n———————————————————\n❌ Script Error\n');
      log('⚠️', err.stack);
      // Create a new Error because an Error from the sandbox behaves differently
      const error = new Error(err.message);
      error.stack = err.stack;
      throw error;
    } finally {
      if (homeyAPI) {
        homeyAPI.destroy();
      }
    }
  }

  async createScript({ name, code }) {
    const newScript = {
      id: uuid.v4(),
      name,
      code,
      lastExecuted: null,
    };

    this.scripts[newScript.id] = newScript;
    this.homey.settings.set('scripts', this.scripts);

    return newScript;
  }

  async updateScript({
    id, name, code, lastExecuted,
  }) {
    this.scripts[id] = {
      ...this.scripts[id],
    };

    if (name != null) {
      this.scripts[id].name = name;
    }

    if (code != null) {
      this.scripts[id].code = code;
    }

    if (lastExecuted != null) {
      this.scripts[id].lastExecuted = lastExecuted;
    }

    this.homey.settings.set('scripts', this.scripts);

    return this.scripts[id];
  }

  async deleteScript({ id }) {
    delete this.scripts[id];
    this.homey.settings.set('scripts', this.scripts);
  }

};
