// Configure environment variables.
require('dotenv').config();

// Imports.
const crypto = require('crypto');
const express = require('express');
const bodyParser = require('body-parser');
const exec = require('child_process').exec;
const spawn = require('child_process').spawn;
const fs = require('fs-extra');
const Rcon = require('rcon-client').Rcon;

// Application setup.
const app = express();
app.use(express.static('static'));
app.set('view engine', 'ejs');
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// Parsing out environment variables.
const APPLICATION = process.env.APPLICATION;
const PORT = process.env.PORT;
const SECRET = process.env.SECRET;
const RCON_PORT = process.env.RCON_PORT;
const RCON_PASSWORD = process.env.RCON_PASSWORD;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

// Store reference to the server heartbeat interval.
let heartbeatInterval;

// A helper function to sleep asynchronously.
const sleep = function (ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
};

// A middleware for validating webhooks from GitHub.
const sigHeaderName = 'X-Hub-Signature';
const verifyPostData = function (req, res, next) {
  const payload = JSON.stringify(req.body);
  if (!payload) {
    return next('Request body empty');
  }
  const sig = req.get(sigHeaderName) || '';
  const hmac = crypto.createHmac('sha1', SECRET);
  const digest = Buffer.from('sha1=' + hmac.update(payload).digest('hex'), 'utf8');
  const checksum = Buffer.from(sig, 'utf8');
  if (checksum.length !== digest.length || !crypto.timingSafeEqual(digest, checksum)) {
    return next(`Request body digest (${digest}) did not match ${sigHeaderName} (${checksum})`);
  }
  return next();
};

// A function to restart this listener server process automatically.
// Currently unused.
const restartProcess = function () {
	const logfile = 'listener-restart.log';
	const out = fs.openSync(logfile, 'a');
	const err = fs.openSync(logfile, 'a');
	spawn(process.argv[0], process.argv.slice(1), {
		detached: true,
		stdio: [ 'ignore', out, err ]
	}).unref();
	process.exit();
};

// A function to support asynchronous execution of OS commands.
const execShellCommand = function (cmd) {
	return new Promise((resolve, reject) => {
		exec(cmd, { maxBuffer: 2 * 1024 * 1024 * 1000 }, (error, stdout, stderr) => {
			if (error) {
				console.warn(error);
			}
			resolve(stdout? stdout : stderr);
		});
	});
};

// Detect the pushed webhook for our server repo from GitHub.
app.post('/', verifyPostData, async function (req, res) {
	try {
		clearInterval(heartbeatInterval);
		let commitId = req.body.after.substring(0, 12);
		console.log(`  >  Detected new commit ${commitId} ...`);

		// Tell GitHub we received the request.
	  res.status(200).send('Request body was signed.');

		// To ensure we do not use stale modpack information, delete it.
		await execShellCommand('rm -rf ../modpack-files/src/');
		console.log(`  >  Deleted previous local modpack content ...`);

		// Forcefully update the repository locally.
		await execShellCommand('git fetch');
		await execShellCommand('git reset --hard origin/master');
		console.log(`  >  Pulled most recent files from git ...`);

		// The Discord chat bot's token is sensitive, so it must be inserted later.
		// await execShellCommand(`sed -i '22s/.*/        token="${DISCORD_BOT_TOKEN}"/' ../modpack-files/src/config/_SERVER/shadowfacts/DiscordChat/DiscordChat.conf`);
		// console.log(`  > Injecting Discord bot token ...`);

		// Install any potentially-new dependencies.
		await execShellCommand('npm install');
		console.log(`  >  Updated the listener server ...`);

		// Delete any local upload from the pack.
		await execShellCommand('rm -rf upload/');
		console.log(`  >  Removed old local modpack build files ...`);

		// Build the updated modpack into files for uploading.
		await execShellCommand(`java -jar ../launcher/builder.jar --version "${commitId}" --input ../modpack-files/ --output upload --manifest-dest "upload/rockhopper-create.json"`);
		console.log(`  >  Built updated modpack ...`);

		// Create a package listing for the updated modpack.
		let packageData = {
	  	minimumVersion: 1,
			packages: [
				{
		      title: 'Rockhopper Modded Survival',
		      name: 'rockhopper',
		      version: `${commitId}`,
		      location: 'rockhopper.json',
		      priority: 0
		    },
				{
					title: 'Rockhopper Airship Survival',
					name: 'rockhopper-skies',
					version: `${commitId}`,
					location: 'rockhopper-skies.json',
					priority: 1
				},
				{
					title: 'Rockhopper Create Survival',
					name: 'rockhopper-create',
					version: `${commitId}`,
					location: 'rockhopper-create.json',
					priority: 2
				},
				{
					title: 'Rockhopper Victoria Survival',
					name: 'rockhopper-victoria',
					version: `${commitId}`,
					location: 'rockhopper-victoria.json',
					priority: 3
				}
		  ]
		};
		const json = JSON.stringify(packageData, null, 2);
		await fs.writeFile('upload/packages.json', json)
		console.log(`  >  Wrote updated package listing to file ...`);

		// Copy our new local build files to the web upload location.
		await execShellCommand('cp -r upload/. /var/www/rockhopper/minecraft/pack/');
		console.log(`  >  Copied new modpack build to web for download ...`);

		// Delete any local server uploads from the pack.
		await execShellCommand('rm -rf server-upload/');
		console.log(`  >  Removed old local modpack server build files ...`);

		// Build the updated modpack into server files.
		await execShellCommand(`java -cp ../launcher/builder.jar com.skcraft.launcher.builder.ServerCopyExport --source ../modpack-files/src --dest server-upload`);
		console.log(`  >  Built updated server files ...`);

		// Count-down, save, and stop the Minecraft server.
		try {
			const rcon = await Rcon.connect({
				host: 'localhost', port: `${RCON_PORT}`, password: `${RCON_PASSWORD}`
			});
			await rcon.send('say There has been a modpack update.');
			await sleep(500);
			await rcon.send('say Please update your modpack client using the launcher.');
			await sleep(500);
			await rcon.send('say The server will restart in 30 seconds.');
			await sleep(5000);
			await rcon.send('say The server will restart in 25 seconds.');
			await sleep(5000);
			await rcon.send('say The server will restart in 20 seconds.');
			await sleep(5000);
			await rcon.send('say The server will restart in 15 seconds.');
			await sleep(5000);
			await rcon.send('say The server will restart in 10 seconds.');
			await sleep(5000);
			await rcon.send('say The server will restart in 5 seconds.');
			await sleep(5000);
			await rcon.send('say The server is restarting now!');
			await sleep(500);
			await rcon.send('save-all');
			await rcon.send('stop');
			await rcon.end();
			console.log(`  >  Stopped the Minecraft server ...`);

		// The Minecraft server may not be running; catch this error and continue.
		} catch (rconError) {
			console.log(`  >  RCON error; the Minecraft server is probably not running ...`);
		}

		// Delete the mods and configuration files that are present on the server.
		await execShellCommand('rm -rf ~/mc-create-18/mods/');
		await execShellCommand('rm -rf ~/mc-create-18/config/');
		console.log(`  >  Removed mods and configuration files from the server ...`);

		// Copy the newly-packaged server content into the server.
		await execShellCommand('cp -a server-upload/. ~/mc-create-18');
		console.log(`  >  Copied new server content to the server ...`);

		// Restart the Minecraft server.
		const logfile = 'spawned-server.log';
		const out = fs.openSync(logfile, 'a');
		const err = fs.openSync(logfile, 'a');
		// TODO: this needs to be patched.
		spawn('java', [ '-Dfml.queryResult=confirm', '-server', '-XX:+UseG1GC', '-XX:MaxGCPauseMillis=100', '-XX:+UseStringDeduplication', '-XX:+UseAES', '-XX:+UseAESIntrinsics', '-Xmx13G', '-Xms8G', '-XX:UseSSE=3', '-jar', 'modpack.jar', 'nogui' ], {
			cwd: '/home/tim/mc-victoria-18/',
			detached: true,
			stdio: [ 'ignore', out, err ]
		}).unref();
		console.log(`  >  Restarted the Minecraft server ...`);

		// Restart the heartbeat service.
		heartbeatInterval = setInterval(heartbeatFunction, 20000);
		console.log(`  >  Restarted the heartbeat service ...`);

		// All done!
		console.log(`  >  Modpack update complete!`);

	// Catch any errors that might occur in the modpack updating process and log them.
	} catch (error) {
		console.log(`  >  An error occurred when attempting modpack update!`);
		console.error(error);
	}

	// Restart this listening server.
	console.log('');
});

// Support pushing a command to the running server.
app.post('/command', async function (req, res) {
	let command = req.body.command;
	try {
		const rcon = await Rcon.connect({
			host: 'localhost', port: `${RCON_PORT}`, password: `${RCON_PASSWORD}`
		});
		let response = await rcon.send(command);
		res.send({
			response: response
		});

	// The Minecraft server may not be running; catch this error and continue.
	} catch (rconError) {
		res.send({
			message: 'The Minecraft server may not be running.',
			error: rconError
		});
	}
});

// Periodically check for signs of life from the server by running `list`.
let missedBeats = 0;
const heartbeatFunction = async function () {
	if (missedBeats > 3) {
		clearInterval(heartbeatInterval);

		// Restart the server if we've missed several consecutive heartbeats.
		console.log(`  >  Too many heartbeats were missed ...`);
		console.log(`  >  Restarting the Minecraft server ...`);
		const logfile = 'spawned-server.log';
		const out = fs.openSync(logfile, 'a');
		const err = fs.openSync(logfile, 'a');
		spawn('java', [ '-Dfml.queryResult=confirm', '-server', '-XX:+UseG1GC', '-XX:MaxGCPauseMillis=100', '-XX:+UseStringDeduplication', '-XX:+UseAES', '-XX:+UseAESIntrinsics', '-Xmx13G', '-Xms8G', '-XX:UseSSE=3', '-jar', 'modpack.jar', 'nogui' ], {
			cwd: '/home/tim/mc-victoria-18/',
			detached: true,
			stdio: [ 'ignore', out, err ]
		}).unref();
		console.log(`  >  Restarted the Minecraft server ...`);
		missedBeats = 0;
		heartbeatInterval = setInterval(heartbeatFunction, 20000);
		console.log('');

	// Otherwise, check for signs of life.
	} else {
		try {
			const rcon = await Rcon.connect({
				host: 'localhost', port: `${RCON_PORT}`, password: `${RCON_PASSWORD}`
			});
			await rcon.send('list');
			missedBeats = 0;

		// The Minecraft server may not be running; the heartbeat failed.
		} catch (rconError) {
			console.log(`  >  Missed heartbeat ${missedBeats} ...`);
			missedBeats++;
		}
	}
};

// Use a middleware that allows us to validate incoming webhooks against GitHub.
app.use((err, req, res, next) => {
  if (err) console.error(err);
  res.status(403).send('Request body was not signed or verification failed.');
});

// Launch the application and begin the server listening.
app.listen(PORT, function () {
	console.log(APPLICATION, 'listening on port', PORT);
});
