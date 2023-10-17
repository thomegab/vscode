/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check
'use strict';

/**
 * @typedef {import('./vs/base/common/product').IProductConfiguration} IProductConfiguration
 * @typedef {import('./vs/base/node/languagePacks').NLSConfiguration} NLSConfiguration
 * @typedef {import('./vs/platform/environment/common/argv').NativeParsedArgs} NativeParsedArgs
 */

const perf = require('./vs/base/common/performance');
perf.mark('code/didStartMain');

const path = require('path');
const fs = require('fs');
const os = require('os');
const bootstrap = require('./bootstrap');
const bootstrapNode = require('./bootstrap-node');
const { getUserDataPath } = require('./vs/platform/environment/node/userDataPath');
const { stripComments } = require('./vs/base/common/stripComments');
const { getUNCHost, addUNCHostToAllowlist } = require('./vs/base/node/unc');
/** @type {Partial<IProductConfiguration>} */
const product = require('../product.json');
const { app, protocol, crashReporter, Menu } = require('electron');

// Enable portable support
const portable = bootstrapNode.configurePortable(product);

// Enable ASAR support
bootstrap.enableASARSupport();

const args = parseCLIArgs();
// Configure static command line arguments
const argvConfig = configureCommandlineSwitchesSync(args);
// Enable sandbox globally unless
// 1) disabled via command line using either
//    `--no-sandbox` or `--disable-chromium-sandbox` argument.
// 2) argv.json contains `disable-chromium-sandbox: true`.
if (args['sandbox'] &&
    !args['disable-chromium-sandbox'] &&
    !argvConfig['disable-chromium-sandbox']) {
    app.enableSandbox();
} else if (app.commandLine.hasSwitch('no-sandbox') &&
    !app.commandLine.hasSwitch('disable-gpu-sandbox')) {
    // Disable GPU sandbox whenever --no-sandbox is used.
    app.commandLine.appendSwitch('disable-gpu-sandbox');
} else {
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('disable-gpu-sandbox');
}

// Set userData path before app 'ready' event
const userDataPath = getUserDataPath(args, product.nameShort ?? 'code-oss-dev');
if (process.platform === 'win32') {
    const userDataUNCHost = getUNCHost(userDataPath);
    if (userDataUNCHost) {
        addUNCHostToAllowlist(userDataUNCHost); // enables to use UNC paths in userDataPath
    }
}
app.setPath('userData', userDataPath);

// Resolve code cache path
const codeCachePath = getCodeCachePath();

// Disable default menu (https://github.com/electron/electron/issues/35512)
Menu.setApplicationMenu(null);

// Configure crash reporter
perf.mark('code/willStartCrashReporter');
// If a crash-reporter-directory is specified we store the crash reports
// in the specified directory and don't upload them to the crash server.
//
// Appcenter crash reporting is enabled if
// * enable-crash-reporter runtime argument is set to 'true'
// * --disable-crash-reporter command line parameter is not set
//
// Disable crash reporting in all other cases.
if (args['crash-reporter-directory'] || (argvConfig['enable-crash-reporter'] && !args['disable-crash-reporter'])) {
    configureCrashReporter();
}
perf.mark('code/didStartCrashReporter');

// Set logs path before app 'ready' event if running portable
// to ensure that no 'logs' folder is created on disk at a
// location outside of the portable directory
// (https://github.com/microsoft/vscode/issues/56651)
if (portable && portable.isPortable) {
    app.setAppLogsPath(path.join(userDataPath, 'logs'));
}

// Register custom schemes with privileges
protocol.registerSchemesAsPrivileged([
    {
        scheme: 'vscode-webview',
        privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, allowServiceWorkers: true, }
    },
    {
        scheme: 'vscode-file',
        privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true }
    }
]);

// Global app listeners
registerListeners();

/**
 * Support user defined locale: load it early before app('ready')
 * to have more things running in parallel.
 *
 * @type {Promise<NLSConfiguration> | undefined}
 */
let nlsConfigurationPromise = undefined;

/**
 * @type {String}
 **/
// Use the most preferred OS language for language recommendation.
// The API might return an empty array on Linux, such as when
// the 'C' locale is the user's only configured locale.
// No matter the OS, if the array is empty, default back to 'en'.
const resolved = app.getPreferredSystemLanguages()?.[0] ?? 'en';
const osLocale = processZhLocale(resolved.toLowerCase());
const metaDataFile = path.join(__dirname, 'nls.metadata.json');
const locale = getUserDefinedLocale(argvConfig);
if (locale) {
    const { getNLSConfiguration } = require('./vs/base/node/languagePacks');
    nlsConfigurationPromise = getNLSConfiguration(product.commit, userDataPath, metaDataFile, locale, osLocale);
}

// Pass in the locale to Electron so that the
// Windows Control Overlay is rendered correctly on Windows.
// For now, don't pass in the locale on macOS due to
// https://github.com/microsoft/vscode/issues/167543.
// If the locale is `qps-ploc`, the Microsoft
// Pseudo Language Language Pack is being used.
// In that case, use `en` as the Electron locale.

if (process.platform === 'win32' || process.platform === 'linux') {
    const electronLocale = (!locale || locale === 'qps-ploc') ? 'en' : locale;
    app.commandLine.appendSwitch('lang', electronLocale);
}

// Load our code once ready
app.once('ready', function () {
    if (args['trace']) {
        const contentTracing = require('electron').contentTracing;

        const traceOptions = {
            categoryFilter: args['trace-category-filter'] || '*',
            traceOptions: args['trace-options'] || 'record-until-full,enable-sampling'
        };

        contentTracing.startRecording(traceOptions).finally(() => handleReady());
    } else {
        handleReady();
    }
});

/**
 * Main startup routine
 *
 * @param {string | undefined} codeCachePath
 * @param {NLSConfiguration} nlsConfig
 */
function startup(codeCachePath, nlsConfig) {
    nlsConfig._languagePackSupport = true;

    process.env['VSCODE_NLS_CONFIG'] = JSON.stringify(nlsConfig);
    process.env['VSCODE_CODE_CACHE_PATH'] = codeCachePath || '';

    // Load main in AMD
    perf.mark('code/willLoadMainBundle');
    require('./bootstrap-amd').load('vs/code/electron-main/main', () => {
        perf.mark('code/didLoadMainBundle');

        // Set to global so that Electron can access it and enable custom protocol
        // loading support (used by standalone windows)
        globalThis.MonacoEnvironment = {};

        globalThis.MonacoEnvironment._id = product.version;

        // @ts-ignore
        globalThis.MonacoEnvironment._log = (severity, ...args) => {
            console.log(`[Renderer ${process.pid}]: ${severity}: ${args.join(' ')}`);
        };

        // Appcelerator/VS Code Extension host
        if (typeof process.env['VSCODE_AMD_ENTRYPOINT'] === 'string') {
            const amdEntrypoint = process.env['VSCODE_AMD_ENTRYPOINT'];
            perf.mark('code/didLoadAMDCode');
            require(`appcd-node/${amdEntrypoint}`);
            return;
        }

        // Startup
        perf.mark('main/startup');
        const log = function () { console.log.apply(console, ['[Main Thread]'].concat(Array.prototype.slice.call(arguments))); };
        // log('start', process.execPath, args);

        // Enable Electron sandbox in the following cases:
        // 1. There is no ASAR archive to prevent other preloads
        // 2. The Electron version does not equal the VS Code version (e.g. when running out of sources)
        if (!process.versions['vscode-electron'] || process.versions['vscode-electron'] !== product.electronVersion) {
            if (process.argv.indexOf('--no-sandbox') === -1) {
                if (process.env['ELECTRON_DISABLE_SANDBOX'] !== 'true') {
                    console.warn(`Could not enable VS Code sandbox because ELECTRON_DISABLE_SANDBOX is not set to 'true'.`);
                } else {
                    app.enableSandbox();
                }
            }
        }

        // Load our code
        require(`./${bootstrap.language}.main`);
    });
}

function handleReady() {
    app.commandLine.appendSwitch('remote-debugging-port', '0');
    app.commandLine.appendSwitch('background-color', '#1e1e1e');
    if (args.verbose) {
        app.commandLine.appendSwitch('enable-logging');
        app.commandLine.appendArgument('--inspect=' + (args['inspect-extensions'] || '6076'));
    }
    // This is the URL passed to the run view and debug view
    // Trust this for simplicity, errors will be handled by the 'launch' webview.
    app.commandLine.appendSwitch('vscode-remote');
    app.commandLine.appendSwitch('vscode-remote-connection-token', args['vscode-remote-connection-token']);
    app.commandLine.appendSwitch('vscode-remote-connection-localetoken', args['vscode-remote-connection-localetoken']);
    // Replace Electron's default appender which writes logs to a file.
    // The new appender uses console.error, which is the correct log level for error messages.
    // console.error messages show up in the "Shared Process" Electron renderer tab.
    // console.log messages show up in the "GPU Process" renderer tab, which is not accessible in VS Code.
    if (args['log-show-logged-messages']) {
        if (console && console.log) {
            console.log = (message) => console.error(message);
        }
    }

    if (args['force-disable-user-env']) {
        process.env['VSCODE_DISABLE_USER_ENV'] = 'true';
    }
    if (args['force-disable-patch']) {
        process.env['VSCODE_DISABLE_PATCH'] = 'true';
    }
    if (args.verbose) {
        console.log('[remoting-host]: Workspaces manager started with these arguments:', process.argv);
    }

    app.whenReady()
        .then(async () => {
            // Ensure file system is setup early enough
            await initializeFileSystem();

            // Require to add `webview.viewtypes` schema contributions
            // from remote to local for default view types.
            try {
                await import('./vs/workbench/services/webview/browser/webviewTypes');
            } catch (err) {
                console.error(err);
            }

            // Parse the common appSettings values
            const [appSettings] = await bootstrap.resolveCommonProperties();
            appSettings.commit = product.commit;
            appSettings.version = product.version;
            appSettings.nameShort = product.nameShort;
            appSettings.url = product.url;
            appSettings.userDataPath = userDataPath;

            // Make sure to persist the telemetryAppender to support any test suite
            globalThis.telemetryAppender = appSettings.telemetryAppender;

            // Run the main startup logic
            if (nlsConfigurationPromise) {
                nlsConfigurationPromise.then(nlsConfig => startup(codeCachePath, nlsConfig));
            } else {
                startup(codeCachePath, { locale: 'en', availableLanguages: {} });
            }
        });
}

/**
 * Initialize file system related things
 */
async function initializeFileSystem() {
    // 1. Ensure storage path exists
    if (!fs.existsSync(path.dirname(userDataPath))) {
        try {
            await fs.promises.mkdir(path.dirname(userDataPath), { recursive: true });
        } catch (error) {
            console.error(`mkdir "${path.dirname(userDataPath)}" failed: ${error.toString()}`);
        }
    }
}

/**
 * Parses command-line arguments and sets the 'userData' path
 * and 'diskCache' to be used.
 *
 * We do this as early as possible, because they are used in
 * various parts of the startup, including log level
 * determination.
 */
function parseCLIArgs() {
    const args = stripComments(process.argv);
    const argsConfig = {
        'help': Boolean,
        'version': Boolean,
        'wait': Boolean,
        'waitMarkerFilePath': String,
        'diff': Boolean,
        'add': String,
        'goto': String,
        'new-window': Boolean,
        'unity-launch': Boolean,
        'file-write': Boolean,
        'file-chmod': Boolean,
        'file-delete': Boolean,
        'user-data-dir': String,
        'locale': String,
        'js-flags': String,
        'install-source': String,
        'max-memory': String,
        'driver-verbose': String,
        'force': Boolean,
        'verbose': Boolean,
        'prof-startup': Boolean,
        'disable-gpu': Boolean,
        'disable-particles': Boolean,
        'log': String,
        'logFile': String,
        'status': Boolean,
        'no-lazy': Boolean,
        'logExtensionHostCommunication': String,
        'trace': Boolean,
        'trace-category-filter': String,
        'trace-options': String,
        'background-color': String,
        'skip-release-notes': Boolean,
        'url': String,
        'open-url': String,
        'list-extensions': Boolean,
        'show-versions': Boolean,
        'prof-extensions': String,
        'inspect-extensions': String,
        'inspect-brk-extensions': String,
        'version-suffix': String,
        'native-exit': Boolean,
        'shutdown': Boolean,
        'add:': String,
        'goto:': String,
        'file-write:': String,
        'file-chmod:': String,
        'file-delete:': String,
        'telemetryLog': String,
        'force-disable-user-env': Boolean,
        'force-disable-patch': Boolean,
        'disable-crash-reporter': Boolean,
        'crash-reporter-directory': String,
        'remote': String,
        'locale:': String
    };

    const result = minimist(args, argsConfig);

    if (result['prof-startup']) {
        return result;
    }

    const options = result['add'] || result['add:'];
    if (typeof options === 'string') {
        result['add'] = [options];
    }
    const files = result['file-write'] || result['file-write:'];
    if (typeof files === 'string') {
        result['file-write'] = [files];
    }
    const filesChmod = result['file-chmod'] || result['file-chmod:'];
    if (typeof filesChmod === 'string') {
        result['file-chmod'] = [filesChmod];
    }
    const filesDelete = result['file-delete'] || result['file-delete:'];
    if (typeof filesDelete === 'string') {
        result['file-delete'] = [filesDelete];
    }
    const locales = result['locale'] || result['locale:'];
    if (typeof locales === 'string') {
        result['locale'] = [locales];
    }
    if (result['locale']) {
        if (!result['locale'][0]) {
            result['locale'] = [];
        } else {
            result['locale'] = [result['locale'][0]];
        }
    }

    if (result['user-data-dir']) {
        // we don't care if it exists, because the app should guarantee its
        // validity when used
        userDataPath = path.normalize(result['user-data-dir']);
    }

    if (result['disable-gpu']) {
        app.disableHardwareAcceleration();
    }

    // patch env based on args
    if (result['js-flags']) {
        process.env['ELECTRON_V8_ARGS'] = result['js-flags'];
    }

    if (result['file-write'] || result['file-chmod'] || result['file-delete']) {
        result['file-write'] = result['file-write'] || [];
        result['file-chmod'] = result['file-chmod'] || [];
        result['file-delete'] = result['file-delete'] || [];
        process.env['VSCODE_FILES_TO_WRITE'] = (result['file-write'].join(os.EOL) || '') + os.EOL +
            (result['file-chmod'].join(os.EOL) || '') + os.EOL +
            (result['file-delete'].join(os.EOL) || '');
    }

    if (result['locale']) {
        process.env['VSCODE_NLS_CONFIG'] = JSON.stringify({ locale: result['locale'][0], availableLanguages: {} });
    }

    // make sure we handle uncaught exceptions
    if (!result['prof-startup'] || result['disable-crash-reporter']) {
        const electronOpts = process.electronEnv || {};
        const errors = electronOpts['errors'] ? electronOpts['errors'] : {};
        errors['uncaughtException'] = !result['prof-startup'];
        electronOpts['errors'] = errors;
        process.electronEnv = electronOpts;
    }

    return result;
}

function getCodeCachePath() {
    if (isBuiltElectron) {
        const parts = app.getAppPath().split(/[\/\\]/);
        while (parts.length > 0) {
            if (parts.pop() === 'Electron.app') {
                return path.join(...parts);
            }
        }
    }

    return app.getAppPath();
}

function getUserDefinedLocale(argsConfig) {
    // The app supports specifying the user-defined UI locale in the command-line.
    // Use it if specified.
    if (argsConfig['locale']) {
        const cliDefinedLocale = argsConfig['locale'];
        if (cliDefinedLocale) {
            return processZhLocale(cliDefinedLocale);
        }
    }

    // Else, use the OS locale
    return osLocale;
}

/**
 * Support for detecting the zh-CN locale based on the region.
 *
 * @param osLocale
 */
function processZhLocale(osLocale) {
    if (osLocale === 'zh-cn') {
        return 'zh-CN'; // no change for zh-cn
    }

    if (osLocale === 'zh-tw' || osLocale === 'zh-hk') {
        return 'zh-TW'; // no change for zh-tw or zh-hk
    }

    // At this point, we found an OS locale that is neither zh-CN, nor zh-TW or zh-HK.
    // For all other locales, we default to zh-CN. The assumption is that
    // it's simpler to teach Chinese users how to switch to a different Chinese locale
    // than users from other regions to Chinese.
    return 'zh-CN';
}

/**
 * @param {NativeParsedArgs} args
 */
function configureCommandlineSwitchesSync(args) {
    const result = process.argv.slice(1);

    // fix for __filename when it is an url
    if (process.platform === 'win32') {
        const index = result.findIndex(value => /^-[-a-zA-Z]*$/.test(value));
        if (index > 0) {
            const possiblePath = result[index - 1];
            if (path.extname(possiblePath) === '.exe' || !path.extname(possiblePath)) {
                result[index - 1] = process.execPath;
            }
        }
    }

    let n = result.indexOf('--driver-verbose');
    if (n >= 0 && n < result.length - 1) {
        if (result[n + 1].startsWith('--')) {
            result.splice(n, 1); // --driver-verbose was used without a value, so we remove it
        }
    }
    n = result.indexOf('--log');
    if (n >= 0 && n < result.length - 1) {
        if (result[n + 1].startsWith('--')) {
            result.splice(n, 2); // --log was used without a value, so we remove it and its value
        }
    }

    // Find and upgrade --extensionHomePath to --extensions-dir
    n = result.indexOf('--extensionHomePath');
    if (n >= 0 && n < result.length - 1) {
        result[n] = '--extensions-dir';
    }

    const x = result.indexOf('--vscode-remote');
    if (x >= 0 && x < result.length - 1) {
        result[x + 1] = result[x + 1].replace(/'/g, '');
        result[x + 1] = result[x + 1].replace(/"/g, '');
    }

    // Rewrite all file paths to use the __filename of `bootstrap.js`
    const bootJsFile = app.getAppPath();

    // Add the script arguments
    result.push('--bootstrapper', bootJsFile);

    // Enable ASAR support
    bootstrap.enableASARSupport();

    if (args.verbose) {
        result.push('--verbose');
    }

    result.push('--vscode-remote');
    result.push(args['vscode-remote']);

    return minimist(result, { string: ['bootstrapper', 'extensions-dir', 'vscode-remote', 'telemetryLog', 'file-chmod', 'file-write', 'file-delete'] });
}

/**
 * Store the NLS config as early as possible.
 */
function setNLSConfig() {
    if (nlsConfigurationPromise) {
        nlsConfigurationPromise.then(nlsConfig => {
            process.env['VSCODE_NLS_CONFIG'] = JSON.stringify(nlsConfig);
        });
    }
}

function registerListeners() {
    app.on('will-finish-launching', () => {
        app.on('open-file', (event, path) => {
            // Paths in args are already normalized
            path = fs.existsSync(path) ? path : undefined;

            if (!path) {
                return;
            }

            bootstrap.log('App#open-file', path);
            globalThis.sendBootLoadWindowOrInstance({
                type: 'open-file',
                path
            });
        });
        app.on('open-url', (event, url) => {
            bootstrap.log('App#open-url', url);
            globalThis.sendBootLoadWindowOrInstance({
                type: 'open-url',
                url
            });
        });
    });

    app.on('ready', () => {
        app.on('activate', (event, hasVisibleWindows, openFile, urls, userInitiated) => {
            if (hasVisibleWindows || !globalThis.sendBootLoadWindowOrInstance) {
                return;
            }

            bootstrap.log('App#activate', openFile, userInitiated);
            if (openFile) {
                globalThis.sendBootLoadWindowOrInstance({
                    type: 'open-file',
                    path: openFile
                });
            } else if (urls) {
                globalThis.sendBootLoadWindowOrInstance({
                    type: 'open-url',
                    url: urls[0]
                });
            } else {
                globalThis.sendBootLoadWindowOrInstance({
                    type: 'activate'
                });
            }
        });

        if (!process.env['VSCODE_DEV']) {
            // whenver not running out of sources, pass telemetry & crash reporter args
            const config = configureServiceTelemetryAndCrashReporter();

            const windowConfig = {
                forceWindow: !config['force-renderer-accessibility'], // TODO@bpasero remove that once screen reader support has adequately been tested
            };

            bootstrap.log('App#configureService', config);
            globalThis.configureService(config, windowConfig);
        }

        // create screens array with each screen size info
        let screens;
        if (electron.screen) {
            screens = electron.screen.getAllDisplays();
        } else {
            screens = [electron.remote.getCurrentWindow().getBounds()];
        }

        if (process.env['VSCODE_HANDLES_UNCAUGHT_ERRORS']) {
            process.on('uncaughtException', function (error) {
                console.error('[uncaught exception in main]: ' + error);
                if (error.stack) {
                    console.error(error.stack);
                }
            });
        }

        // return the screens in `data`
        globalThis.sendBootLoadWindowOrInstance({ screens: screens, initialStartup: true });
    });

    app.on('window-all-closed', function () {
        // Mac only
        if (process.platform === 'darwin') {
            return;
        }

        app.quit();
    });
}

function configureCrashReporter() {
    const env = { ...process.env };

    // If crash reporting is not disabled we handle uncaught exceptions and forward to the crash reporter.
    // The crash reporter will not report when running out of sources because there are no external crash reports to forward to.
    if (!process.env['VSCODE_DISABLE_CRASH_REPORTER'] && !isBuiltElectron) {
        const CrashReporter = require('vs/base/parts/sandbox/electron-sandbox/crashReporter');

        if (!env['VSCODE_PIPE_LOGS'] && (isLinux || isMacintosh || isWindows)) {
            env['ELECTRON_ENABLE_LOGGING'] = '1';
        }

        if (!env['VSCODE_HANDLES_UNCAUGHT_ERRORS']) {
            process.on('uncaughtException', (error) => {
                console.error('[uncaught exception in main]: ' + error);

                if (error.stack) {
                    console.error(error.stack);
                }
            });
        }

        // handle unhandled promises rejections
        process.on('unhandledRejection', (reason) => {
            console.error('[unhandled promise rejection in main]: ' + reason);
        });

        // startup crash reporter as first thing
        CrashReporter.startup({
            productName: product.nameLong,
            companyName: 'Microsoft Corporation',
            submitURL: 'https://rink.hockeyapp.net/api/2/apps/' + product.hockeyAppId + '/crashes/upload',
            extra: { version: app.getVersion(), commit: product.commit, vs: isWindows ? '1' : process.versions['vscode-api'] }
        }, env);
    }
}

/**
 * Log diagnosic data.
 */
function logDiagnostics() {
    if (args.verbose) {
        console.log(`VERBOSE: current build ${product.commit || '0000000'}, global app data: ${app.getPath('appData')}`);
        console.log(`VERBOSE: argv {`);
        for (let i = 0; i < process.argv.length; i++) {
            console.log(`  ${i}: ${process.argv[i]}`);
        }
        console.log(`}`);
    }

    const now = Date.now();
    if (typeof globalThis['VSCODE_LOG_BENCHMARK'] !== 'undefined') {
        globalThis['VSCODE_LOG_BENCHMARK'](now, 'electron start');
    }

    if (args.log || args.logFile) {
        console.log(`STARTUP with logs: (${process.pid})`);

        const consoleLogger = new bootstrap.ElectronLogService(product.commit, product.version, process.stdout, process.stderr);
        consoleLogger.setLevel(bootstrap.LogLevel.Info);

        if (args.logFile) {
            consoleLogger.logger.addLogOutput(bootstrap.createLogFileLogger(args.logFile, bootstrap.getLogLevel(args), fs));
        }

        if (args.log) {
            consoleLogger.logger.addLogOutput(bootstrap.createRotatingLogFileLogger(args.log, bootstrap.getLogLevel(args), fs));
        }

        consoleLogger.info(`Startup: ---`);
        consoleLogger.info(`Startup: pid: ${process.pid}`);
        consoleLogger.info(`Startup: executable: ${app.getPath('exe')}`);
        consoleLogger.info(`Startup: appRoot: ${app.getAppPath()}`);
        consoleLogger.info(`Startup: commit: ${product.commit}`);
        consoleLogger.info(`Startup: version: ${product.version}`);
        consoleLogger.info(`Startup: arch: ${os.arch()}`);
        consoleLogger.info(`Startup: platform: ${process.platform}`);
        consoleLogger.info(`Startup: usingPureWebSockets: ${!args['force-ipc']}`);
        consoleLogger.info(`Startup: localRender: ${args['local-render']}`);
        consoleLogger.info(`Startup: remote: ${args['vscode-remote'] || ''}`);
        consoleLogger.info(`Startup: size: ${process.getProcessMemoryInfo().private / 1024} MB`);
        consoleLogger.info(`Startup: arguments: ${process.argv.slice(1).join(' ')}`);
        consoleLogger.info(`Startup: node lib: ${bootstrap.getCLILibPath()}`);
        consoleLogger.info(`Startup: ---`);

        consoleLogger.info(`Startup: currentDir=${process.cwd}`);
        consoleLogger.info(`Startup: gpuStartup=${app.commandLine.hasSwitch('gpu-startup')}`);
        consoleLogger.info(`Startup: noSplash=${app.commandLine.hasSwitch('no-sandbox')}`);
        consoleLogger.info(`Startup: inspect port=${app.commandLine.getSwitchValue('inspect-extensions')}`);
        consoleLogger.info(`Startup: logs: ${args.log} ${args.logFile}`);

        const extPath = args['extensions-dir'] || '';

        consoleLogger.info(`Startup: cwd=${process.cwd()}, ${app.getAppPath()}, ${extPath}`);

        if (isWindows) {
            const configFile = process.env['VSCODE_CWD'] || path.join(app.getPath('appData'), product.applicationName, 'args.txt');
            try {
                const args = fs.readFileSync(configFile, 'utf8');
                consoleLogger.info(`Startup: argsfile: ${configFile} => ${args}`);
            } catch (err) {
                consoleLogger.info(`Startup: no args file: ${configFile}`);
            }
        }

        if (args.verbose) {
            process.env['ELECTRON_ENABLE_LOGGING'] = '1';
        }
    }
}

function isBuiltElectron() {
    const electronVersion = process.versions['electron'];
    return /^[0-9]+\.[0-9]+\.[0-9]+/.test(electronVersion);
}

function configureServiceTelemetryAndCrashReporter() {
    const config = {
        ...args,
        ...product.diagnostics
    };

    // Add process context information to telemetry config
    config.machineId = globalThis.instanceMachineId;
    config.machineName = globalThis.instanceMachineName;
    config.msi = globalThis.instanceMachineInfo;

    // Give back configuration
    return config;
}

function configureIpc() {
    const ignoredIpcChannels = [
        'v8-compile-cache'
    ];

    function canIpc(explicitlyAllowed) {
        if (explicitlyAllowed) {
            return true;
        }

        return ignoredIpcChannels.indexOf(ipcEvent.channel) !== -1;
    }

    const ipcMain = new bootstrap.ElectronIPCMain(canIpc);
    ipcMain.registerChannel('vscode:exit', (event, reply) => {
        app.quit();
        reply(undefined);
    });

    ipcMain.registerChannel('vscode:fetchShellEnv', async (event, reply) => {
        reply(await bootstrap.fetchShellEnv());
    });
    ipcMain.registerChannel('vscode:toggleSharedProcess', async (event, reply, enabled) => {
        reply(await bootstrap.toggleSharedProcess(enabled));
    });
    ipcMain.registerChannel('vscode:telemetry', async (event, reply, data) => {
        bootstrap.sendTelemetry(data.event, data.data);
        reply(true);
    });
    ipcMain.registerChannel('vscode:telemetryV3', async (event, reply, data) => {
        bootstrap.sendTelemetry(data.event, data.data);
        reply(true);
    });
    ipcMain.registerChannel('vscode:reportError', async (event, reply, data) => {
        if (data.error) {
            bootstrap.log(data.error.toString());
        }
        if (data.error) {
            bootstrap.log(data.error.stack);
        }
        if (data.error) {
            console.error(data.error.toString());
        }
        if (data.error) {
            console.error(data.error.stack);
        }
        reply(true);
    });
    ipcMain.registerChannel('vscode:ping', async (event, reply) => {
        reply(true);
    });

    bootstrap.registerIpcMain(ipcMain);

    return ipcMain;
}

function handleStartupData(): void {
    if (process.env['VSCODE_PIPE_LOGS']) {
        process.env['VSCODE_LOG_STACK'] = 'false'; // since we write log output to the console
        const logFile = app.getPath('userData') + '/main.log';
        try {
            bootstrap.enableLog(logFile, logFile, false);
        } catch (error) {
            console.error(error);
        }
    }
    logDiagnostics();

    setNLSConfig();
    bootstrap.registerListeners();
    registerListeners();
    bootstrap.patchExecEnvironment();

    if (args.verbose) {
        console.log('VSCode main -> getBootConfig');
    }
    globalThis.getBootConfig().then(async ([name, config, logsPath]) => {
        if (args.verbose) {
            console.log('VSCode main -> got boot config');
        }

        // Emit Event when the store fails to load
        config.storeService.onError(e => console.error('StoreService#load fails', e));
        // Load services
        await bootstrap.loadServices(name, config);
        // Log Telemetry
        bootstrap.sendTelemetry('mainStarted', { ...await bootstrap.resolveCommonProperties(), config });
        // Load bootstrap main file
        await bootstrap.loadBootstrapMain(name, config, logsPath);
        // Load main
        import('./bootstrap-main');
    }).catch(console.error);
}

handleStartupData();
