// server.js

import Hyperswarm from 'hyperswarm';
import Docker from 'dockerode';
import crypto from 'hypercore-crypto';
import { PassThrough } from 'stream';
import os from "os";
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { spawn } from 'child_process';
import * as validation from './utils/validation.js';
import rateLimiter from './utils/rateLimiter.js';
import { createErrorResponse, sanitizeErrorMessage } from '../utils/errorHandler.js';
import logger from './utils/logger.js';
import * as composeManager from './utils/composeManager.js';

// Load environment variables from .env file
dotenv.config();

const docker = new Docker({
  socketPath: os.platform() === "win32" ? '//./pipe/dockerDesktopLinuxEngine' : '/var/run/docker.sock',
});
const swarm = new Hyperswarm();
const connectedPeers = new Set();
const terminalSessions = new Map(); // Map to track terminal sessions per peer
const logsStreams = new Map(); // Map to track logs streams: key = `${peerId}:${containerId}`

/**
 * Helper function to extract volumes list from Docker API response
 * Docker API can return volumes in different formats depending on version
 * @param {Object|Array} volumesResult - Response from docker.listVolumes()
 * @returns {Array} - Array of volume objects
 */
function extractVolumesList(volumesResult) {
  if (Array.isArray(volumesResult)) {
    return volumesResult;
  } else if (volumesResult && Array.isArray(volumesResult.Volumes)) {
    return volumesResult.Volumes;
  } else if (volumesResult && volumesResult.volumes && Array.isArray(volumesResult.volumes)) {
    return volumesResult.volumes;
  }
  return [];
}

// Function to generate a new key
function generateNewKey() {
  const newKey = crypto.randomBytes(32);
  fs.appendFileSync('.env', `SERVER_KEY=${newKey.toString('hex')}\n`, { flag: 'a' });
  return newKey;
}

// Load or generate the topic key
let keyHex = process.env.SERVER_KEY;
if (!keyHex) {
  console.log('[INFO] No SERVER_KEY found in .env. Generating a new one...');
  const newKey = generateNewKey();
  keyHex = newKey.toString('hex');
} else {
  console.log('[INFO] SERVER_KEY loaded from .env.');
}

// Convert the keyHex to a Buffer
const topic = Buffer.from(keyHex, 'hex');

logger.info(`Server started with topic: ${topic.toString('hex')}`);

// Start listening or further implementation logic here
// Join the swarm with the generated topic
swarm.join(topic, { server: true, client: false });

// Handle incoming peer connections
swarm.on('connection', (peer) => {
  logger.info('Peer connected', { peerId: peer.remotePublicKey?.toString('hex')?.substring(0, 12) });
  connectedPeers.add(peer);

  peer.on('data', async (data) => {
    let parsedData = null;
    try {
      parsedData = JSON.parse(data.toString());
      
      // Rate limiting check
      if (!rateLimiter.isAllowed(peer, parsedData.command)) {
        console.warn(`[WARN] Rate limit exceeded for peer: ${parsedData.command}`);
        peer.write(JSON.stringify({
          error: 'Rate limit exceeded. Please wait before making more requests.',
          code: 'RATE_LIMIT_EXCEEDED'
        }));
        return;
      }
      
      let response;

      switch (parsedData.command) {
        case 'listContainers':
          console.log('[INFO] Handling \'listContainers\' command');
          try {
            const containers = await docker.listContainers({ all: true });

            const detailedContainers = await Promise.all(
              containers.map(async (container) => {
                try {
                  const details = await docker.getContainer(container.Id).inspect();

                  // Safely access the IP address
                  let ipAddress = 'No IP Assigned';
                  if (details.NetworkSettings && details.NetworkSettings.Networks) {
                    const networks = Object.values(details.NetworkSettings.Networks);
                    if (networks.length > 0 && networks[0].IPAddress) {
                      ipAddress = networks[0].IPAddress;
                    }
                  }

                  return { ...container, ipAddress }; // Add IP address to container data
                } catch (error) {
                  console.error(`[ERROR] Failed to inspect container ${container.Id}: ${error.message}`);
                  return { ...container, ipAddress: 'Error Retrieving IP' }; // Return partial data with error
                }
              })
            );

            response = { type: 'containers', data: detailedContainers };
          } catch (error) {
            console.error(`[ERROR] Failed to list containers: ${error.message}`);
            response = { error: 'Failed to list containers' };
          }
          break;

        case 'inspectContainer':
          console.log(`[INFO] Handling 'inspectContainer' command for container: ${parsedData.args.id}`);
          const container = docker.getContainer(parsedData.args.id);
          const config = await container.inspect();
          response = { type: 'containerConfig', data: config };
          break;
        case 'dockerCommand':
          console.log(`[INFO] Handling 'dockerCommand' with data: ${parsedData.data}`);

          try {
            // Validate command input
            const commandStr = validation.sanitizeString(parsedData.data, 500);
            if (!commandStr || !commandStr.startsWith('docker ')) {
              throw new Error('Invalid command format');
            }
            
            // Additional server-side validation
            const dangerousPatterns = ['exec', 'run', 'rm -f', 'prune', 'system prune'];
            if (dangerousPatterns.some(pattern => commandStr.includes(pattern))) {
              throw new Error('Command not allowed for security reasons');
            }
            
            const command = commandStr.split(' '); // Split the command into executable and args
            const executable = command[0];
            const args = command.slice(1);
            
            // Ensure only docker executable
            if (executable !== 'docker') {
              throw new Error('Only docker commands are allowed');
            }

            const childProcess = spawn(executable, args);

            let response = {
              type: 'dockerOutput',
              connectionId: parsedData.connectionId,
              data: '',
            };

            // Stream stdout to the peer
            childProcess.stdout.on('data', (data) => {
              peer.write(
                JSON.stringify({
                  ...response,
                  data: data.toString('base64'),
                  encoding: 'base64',
                })
              );
            });

            // Stream stderr to the peer
            childProcess.stderr.on('data', (data) => {
              console.error(`[ERROR] Command stderr: ${data.toString()}`);
              peer.write(
                JSON.stringify({
                  ...response,
                  data: `[ERROR] ${data.toString('base64')}`,
                  encoding: 'base64',
                })
              );
            });

            // Handle command exit
            childProcess.on('close', (code) => {
              const exitMessage = `[INFO] Command exited with code ${code}`;
              console.log(exitMessage);
              peer.write(
                JSON.stringify({
                  ...response,
                  data: exitMessage,
                })
              );
            });
          } catch (error) {
            console.error(`[ERROR] Command execution failed: ${error.message}`);
            peer.write(
              JSON.stringify({
                type: 'dockerOutput',
                connectionId: parsedData.connectionId,
                data: `[ERROR] Failed to execute command: ${error.message}`,
              })
            );
          }
          break;


        case 'logs':
          console.log(`[INFO] Handling 'logs' command for container: ${parsedData.args.id}`);
          const containerId = parsedData.args.id;
          const logsKey = `${peer.remotePublicKey?.toString('hex') || 'unknown'}:${containerId}`;
          
          // Clean up existing logs stream for this peer/container if it exists
          if (logsStreams.has(logsKey)) {
            const existingStream = logsStreams.get(logsKey);
            try {
              existingStream.destroy();
              console.log(`[INFO] Destroyed existing logs stream for container: ${containerId}`);
            } catch (err) {
              console.error(`[ERROR] Failed to destroy existing logs stream: ${err.message}`);
            }
            logsStreams.delete(logsKey);
          }
          
          const logsContainer = docker.getContainer(containerId);
          const logsStream = await logsContainer.logs({
            stdout: true,
            stderr: true,
            tail: 100, // Fetch the last 100 log lines
            follow: true, // Stream live logs
          });

          // Store stream reference
          logsStreams.set(logsKey, logsStream);

          logsStream.on('data', (chunk) => {
            peer.write(
              JSON.stringify({
                type: 'logs',
                data: chunk.toString('base64'), // Send base64 encoded logs
              })
            );
          });

          logsStream.on('end', () => {
            console.log(`[INFO] Log stream ended for container: ${containerId}`);
            logsStreams.delete(logsKey);
          });

          logsStream.on('error', (err) => {
            console.error(`[ERROR] Log stream error for container ${containerId}: ${err.message}`);
            peer.write(JSON.stringify({ error: `Log stream error: ${err.message}` }));
            logsStreams.delete(logsKey);
          });

          break;

        case 'duplicateContainer':
          console.log('[INFO] Handling \'duplicateContainer\' command');
          const { name, image, hostname, netmode, cpu, memory, config: dupConfig } = parsedData.args;
          const memoryInMB = memory * 1024 * 1024;

          await duplicateContainer(name, image, hostname, netmode, cpu, memoryInMB, dupConfig, peer);
          return; // Response is handled within the duplicateContainer function
        case 'startContainer':
          console.log(`[INFO] Handling 'startContainer' command for container: ${parsedData.args.id}`);
          await docker.getContainer(parsedData.args.id).start();
          response = { success: true, message: `Container ${parsedData.args.id} started` };
          break;

        case 'stopContainer':
          console.log(`[INFO] Handling 'stopContainer' command for container: ${parsedData.args.id}`);
          await docker.getContainer(parsedData.args.id).stop();
          response = { success: true, message: `Container ${parsedData.args.id} stopped` };
          break;

        case 'restartContainer':
          console.log(`[INFO] Handling 'restartContainer' command for container: ${parsedData.args.id}`);
          await docker.getContainer(parsedData.args.id).restart();
          response = { success: true, message: `Container ${parsedData.args.id} restarted` };
          break;

        case 'pauseContainer':
          console.log(`[INFO] Handling 'pauseContainer' command for container: ${parsedData.args.id}`);
          await docker.getContainer(parsedData.args.id).pause();
          response = { success: true, message: `Container ${parsedData.args.id} paused` };
          break;

        case 'unpauseContainer':
          console.log(`[INFO] Handling 'unpauseContainer' command for container: ${parsedData.args.id}`);
          await docker.getContainer(parsedData.args.id).unpause();
          response = { success: true, message: `Container ${parsedData.args.id} unpaused` };
          break;

        case 'renameContainer':
          console.log(`[INFO] Handling 'renameContainer' command for container: ${parsedData.args.id}`);
          const newName = validation.sanitizeString(parsedData.args.name, 63);
          if (!newName || !validation.isValidContainerName(newName)) {
            throw new Error('Invalid container name. Must be alphanumeric with dashes/underscores, 1-63 characters.');
          }
          const containerToRename = docker.getContainer(parsedData.args.id);
          await containerToRename.rename({ name: newName });
          response = { success: true, message: `Container renamed to "${newName}"` };
          break;

        case 'commitContainer':
          console.log(`[INFO] Handling 'commitContainer' command for container: ${parsedData.args.id}`);
          try {
            const commitOptions = {
              repo: validation.sanitizeString(parsedData.args.repo, 255),
              tag: validation.sanitizeString(parsedData.args.tag || 'latest', 128),
            };
            if (parsedData.args.message) {
              commitOptions.comment = validation.sanitizeString(parsedData.args.message, 500);
            }
            if (parsedData.args.author) {
              commitOptions.author = validation.sanitizeString(parsedData.args.author, 255);
            }
            const containerToCommit = docker.getContainer(parsedData.args.id);
            const image = await containerToCommit.commit(commitOptions);
            response = { success: true, message: `Container committed as ${commitOptions.repo}:${commitOptions.tag}`, data: image.id };
          } catch (error) {
            console.error(`[ERROR] Failed to commit container: ${error.message}`);
            response = { error: `Failed to commit container: ${error.message}` };
          }
          break;

        case 'exportContainer':
          console.log(`[INFO] Handling 'exportContainer' command for container: ${parsedData.args.id}`);
          try {
            const containerToExport = docker.getContainer(parsedData.args.id);
            const exportStream = await containerToExport.getArchive({
              path: '/'
            });
            // Note: In a real implementation, you'd want to stream this to the client
            // For now, we'll just acknowledge the request
            response = { success: true, message: `Container ${parsedData.args.id} export initiated` };
          } catch (error) {
            console.error(`[ERROR] Failed to export container: ${error.message}`);
            response = { error: `Failed to export container: ${error.message}` };
          }
          break;

        case 'execContainer':
          console.log(`[INFO] Handling 'execContainer' command for container: ${parsedData.args.id}`);
          try {
            const containerToExec = docker.getContainer(parsedData.args.id);
            const execOptions = {
              Cmd: parsedData.args.cmd || ['/bin/sh'],
              AttachStdin: true,
              AttachStdout: true,
              AttachStderr: true,
              Tty: parsedData.args.tty !== false,
            };
            const exec = await containerToExec.exec(execOptions);
            const stream = await exec.start({ hijack: true, stdin: true });
            
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            containerToExec.modem.demuxStream(stream, stdout, stderr);

            const execKey = `${peer.remotePublicKey?.toString('hex') || 'unknown'}:${parsedData.args.id}:${exec.id}`;
            const onExecData = (input) => {
              try {
                const parsed = JSON.parse(input.toString());
                if (parsed.type === 'execInput' && parsed.execId === exec.id && parsed.data) {
                  const inputData = parsed.encoding === 'base64'
                    ? Buffer.from(parsed.data, 'base64')
                    : Buffer.from(parsed.data);
                  stream.write(inputData);
                }
              } catch (err) {
                console.error(`[ERROR] Failed to parse exec input: ${err.message}`);
              }
            };

            peer.on('data', onExecData);
            terminalSessions.set(peer, { containerId: parsedData.args.id, exec, stream, onData: onExecData, execId: exec.id });

            stdout.on('data', (chunk) => {
              peer.write(JSON.stringify({
                type: 'execOutput',
                containerId: parsedData.args.id,
                execId: exec.id,
                data: chunk.toString('base64'),
                encoding: 'base64',
              }));
            });

            stderr.on('data', (chunk) => {
              peer.write(JSON.stringify({
                type: 'execErrorOutput',
                containerId: parsedData.args.id,
                execId: exec.id,
                data: chunk.toString('base64'),
                encoding: 'base64',
              }));
            });

            response = { success: true, message: `Exec session started`, execId: exec.id };
          } catch (error) {
            console.error(`[ERROR] Failed to exec container: ${error.message}`);
            response = { error: `Failed to exec container: ${error.message}` };
          }
          break;

        case 'bulkContainerOperation':
          console.log(`[INFO] Handling 'bulkContainerOperation' command`);
          try {
            const { containerIds, operation } = parsedData.args;
            if (!Array.isArray(containerIds) || containerIds.length === 0) {
              throw new Error('No containers specified');
            }
            if (!['start', 'stop', 'restart', 'pause', 'unpause', 'remove'].includes(operation)) {
              throw new Error('Invalid operation');
            }

            const results = [];
            for (const containerId of containerIds) {
              try {
                const container = docker.getContainer(containerId);
                switch (operation) {
                  case 'start':
                    await container.start();
                    break;
                  case 'stop':
                    await container.stop();
                    break;
                  case 'restart':
                    await container.restart();
                    break;
                  case 'pause':
                    await container.pause();
                    break;
                  case 'unpause':
                    await container.unpause();
                    break;
                  case 'remove':
                    await container.remove({ force: true });
                    break;
                }
                results.push({ id: containerId, success: true });
              } catch (err) {
                results.push({ id: containerId, success: false, error: err.message });
              }
            }
            response = { success: true, message: `Bulk operation completed`, results };
          } catch (error) {
            console.error(`[ERROR] Failed to perform bulk operation: ${error.message}`);
            response = { error: `Failed to perform bulk operation: ${error.message}` };
          }
          break;

        case 'updateContainer':
          console.log(`[INFO] Handling 'updateContainer' command for container: ${parsedData.args.id}`);
          try {
            const container = docker.getContainer(parsedData.args.id);
            const inspect = await container.inspect();
            
            // Note: Docker doesn't support updating all container properties without recreating
            // This will handle what can be updated (like restart policy via update)
            // For full updates, containers need to be recreated
            response = { 
              success: true, 
              message: 'Container update initiated. Note: Some changes require container recreation.',
              note: 'Most container properties cannot be updated on running containers. Consider recreating the container with new settings.'
            };
          } catch (error) {
            console.error(`[ERROR] Failed to update container: ${error.message}`);
            response = { error: `Failed to update container: ${error.message}` };
          }
          break;

        case 'removeContainer':
          console.log(`[INFO] Handling 'removeContainer' command for container: ${parsedData.args.id}`);
          const removedContainerId = parsedData.args.id;
          
          // Clean up all logs streams for this container
          const logsKeysToDelete = [];
          for (const [key, stream] of logsStreams.entries()) {
            if (key.endsWith(`:${removedContainerId}`)) {
              try {
                stream.destroy();
                console.log(`[INFO] Destroyed logs stream for removed container: ${key}`);
              } catch (err) {
                console.error(`[ERROR] Failed to destroy logs stream ${key}: ${err.message}`);
              }
              logsKeysToDelete.push(key);
            }
          }
          logsKeysToDelete.forEach(key => logsStreams.delete(key));
          
          await docker.getContainer(removedContainerId).remove({ force: true });
          response = { success: true, message: `Container ${removedContainerId} removed` };
          break;

          case 'deployContainer':
            logger.info('Handling deployContainer command');
            const args = parsedData.args;

            try {
              // Validate and sanitize container name
              const containerName = validation.sanitizeString(args.containerName, 63);
              if (!containerName || !validation.isValidContainerName(containerName)) {
                throw new Error('Invalid or missing container name. Must be alphanumeric with dashes/underscores, 1-63 characters.');
              }
              args.containerName = containerName;

              // Validate and sanitize image
              const image = validation.sanitizeString(args.image, 255);
              if (!image || !validation.isValidImageName(image)) {
                throw new Error('Invalid or missing Docker image name.');
              }
              args.image = image;

              // Check if container name already exists
              const existingContainers = await docker.listContainers({ all: true });
              const nameExists = existingContainers.some(c => c.Names.includes(`/${args.containerName}`));
              if (nameExists) {
                throw new Error(`Container name '${args.containerName}' already exists.`);
              }

              logger.info(`Pulling Docker image: ${args.image}`);

              // Pull the Docker image
              const pullStream = await docker.pull(args.image);
              await new Promise((resolve, reject) => {
                docker.modem.followProgress(pullStream, (err) => (err ? reject(err) : resolve()));
              });

              logger.info(`Image pulled successfully: ${args.image}`);

              // Build container configuration
              const containerConfig = {
                name: args.containerName,
                Image: args.image,
              };

              // Basic settings
              if (args.command) {
                containerConfig.Cmd = args.command.split(' ');
              }
              if (args.entrypoint) {
                containerConfig.Entrypoint = args.entrypoint.split(' ');
              }
              if (args.workingDir) {
                containerConfig.WorkingDir = args.workingDir;
              }

              // Environment variables
              if (args.env && Array.isArray(args.env)) {
                containerConfig.Env = args.env
                  .filter(e => e.name && e.value !== undefined)
                  .map(e => {
                    const name = validation.sanitizeEnvVarName(e.name);
                    const value = validation.sanitizeEnvVarValue(e.value);
                    
                    // Additional validation: check if preset value was modified
                    // Note: This is a basic check - full template validation happens client-side
                    if (e.preset === true && name) {
                      // Log warning if preset value appears to be modified
                      // (We can't fully validate without template, but we can check format)
                      logger.debug(`Preset env var ${name} being set to: ${value}`);
                    }
                    
                    return name && value !== null ? `${name}=${value}` : null;
                  })
                  .filter(e => e !== null);
              }

              // Labels
              if (args.labels && typeof args.labels === 'object') {
                containerConfig.Labels = {};
                for (const [key, value] of Object.entries(args.labels)) {
                  const sanitizedKey = validation.sanitizeLabelKey(key);
                  const sanitizedValue = validation.sanitizeLabelValue(value);
                  if (sanitizedKey && sanitizedValue !== null) {
                    containerConfig.Labels[sanitizedKey] = sanitizedValue;
                  }
                }
              }

              // Hostname and domainname
              if (args.hostname) {
                const hostname = validation.sanitizeString(args.hostname, 253);
                if (validation.isValidHostname(hostname)) {
                  containerConfig.Hostname = hostname;
                }
              }
              if (args.domainname) {
                const domainname = validation.sanitizeString(args.domainname, 253);
                if (validation.isValidHostname(domainname)) {
                  containerConfig.Domainname = domainname;
                }
              }

              // User
              if (args.user) containerConfig.User = args.user;

              // Health check
              if (args.healthCmd) {
                containerConfig.Healthcheck = {
                  Test: args.healthCmd.startsWith('CMD-SHELL') 
                    ? args.healthCmd.split(' ').slice(1)
                    : ['CMD-SHELL', args.healthCmd],
                  Interval: args.healthInterval ? args.healthInterval * 1000000000 : 30000000000, // nanoseconds
                  Timeout: args.healthTimeout ? args.healthTimeout * 1000000000 : 10000000000,
                  Retries: args.healthRetries || 3,
                  StartPeriod: args.healthStartPeriod ? args.healthStartPeriod * 1000000000 : 0,
                };
              }

              // TTY and Stdin
              containerConfig.Tty = args.tty === true;
              containerConfig.OpenStdin = args.stdinOpen === true;
              containerConfig.AttachStdin = args.stdinOpen === true;
              containerConfig.AttachStdout = true;
              containerConfig.AttachStderr = true;

              // Read-only root filesystem
              if (args.readonlyRootfs === true) {
                containerConfig.ReadonlyRootfs = true;
              }

              // Build HostConfig
              const hostConfig = {
                NetworkMode: args.networkMode || 'bridge',
              };

              // Port bindings
              if (args.ports && Array.isArray(args.ports)) {
                hostConfig.PortBindings = {};
                args.ports.forEach((portStr) => {
                  const sanitizedPort = validation.sanitizeString(portStr, 50);
                  if (validation.isValidPortMapping(sanitizedPort)) {
                    // Support both "host:container/protocol" and "container/protocol" formats
                    if (sanitizedPort.includes(':')) {
                      const [hostPort, rest] = sanitizedPort.split(':');
                      const [containerPort, protocol] = rest.split('/');
                      hostConfig.PortBindings[`${containerPort}/${protocol || 'tcp'}`] = [{ HostPort: hostPort }];
                    } else {
                      const [containerPort, protocol] = sanitizedPort.split('/');
                      hostConfig.PortBindings[`${containerPort}/${protocol || 'tcp'}`] = [{ HostPort: containerPort }];
                    }
                  }
                });
              }

              // Volumes
              if (args.volumes && Array.isArray(args.volumes)) {
                hostConfig.Binds = args.volumes
                  .map(v => validation.sanitizeString(v, 500))
                  .filter(v => v && validation.isValidVolumeMount(v));
              }

              // Tmpfs
              if (args.tmpfs && Array.isArray(args.tmpfs)) {
                hostConfig.Tmpfs = {};
                args.tmpfs.forEach(tmpfsStr => {
                  const [path, ...opts] = tmpfsStr.split(':');
                  if (path) {
                    hostConfig.Tmpfs[path] = opts.join(':') || '';
                  }
                });
              }

              // Resources
              if (args.cpuLimit) {
                hostConfig.NanoCpus = args.cpuLimit * 1000000000; // Convert to nanoseconds
              }
              if (args.cpuReservation) {
                hostConfig.CpuQuota = args.cpuReservation * 1000000000;
              }
              if (args.cpuShares) {
                hostConfig.CpuShares = args.cpuShares;
              }
              if (args.memoryLimit) {
                hostConfig.Memory = args.memoryLimit * 1024 * 1024; // Convert MB to bytes
              }
              if (args.memoryReservation) {
                hostConfig.MemoryReservation = args.memoryReservation * 1024 * 1024;
              }
              if (args.memorySwap !== undefined && args.memorySwap !== null) {
                hostConfig.MemorySwap = args.memorySwap === -1 ? -1 : args.memorySwap * 1024 * 1024;
              }

              // Devices
              if (args.devices && Array.isArray(args.devices)) {
                hostConfig.Devices = args.devices.map(deviceStr => {
                  const parts = deviceStr.split(':');
                  return {
                    PathOnHost: parts[0],
                    PathInContainer: parts[1] || parts[0],
                    CgroupPermissions: parts[2] || 'rwm'
                  };
                });
              }

              // DNS
              if (args.dns && Array.isArray(args.dns)) {
                hostConfig.Dns = args.dns
                  .map(dns => validation.sanitizeString(dns, 50))
                  .filter(dns => validation.isValidDnsServer(dns));
              }

              // Extra hosts
              if (args.extraHosts && Array.isArray(args.extraHosts)) {
                hostConfig.ExtraHosts = args.extraHosts;
              }

              // Restart policy
              if (args.restartPolicy) {
                hostConfig.RestartPolicy = {
                  Name: args.restartPolicy,
                  MaximumRetryCount: args.restartMaxRetries || 0
                };
              }

              // Auto remove
              if (args.autoRemove === true) {
                hostConfig.AutoRemove = true;
              }

              // Privileged
              if (args.privileged === true) {
                hostConfig.Privileged = true;
              }

              // Capabilities
              if (args.capabilities && Array.isArray(args.capabilities)) {
                hostConfig.CapAdd = args.capabilities;
              }

              // Security options
              if (args.securityOpts && Array.isArray(args.securityOpts)) {
                hostConfig.SecurityOpt = args.securityOpts;
              }

              // Sysctls
              if (args.sysctls && typeof args.sysctls === 'object') {
                hostConfig.Sysctls = args.sysctls;
              }

              // Ulimits
              if (args.ulimits && Array.isArray(args.ulimits)) {
                hostConfig.Ulimits = args.ulimits;
              }

              // OOM kill disable
              if (args.oomKillDisable === true) {
                hostConfig.OomKillDisable = true;
              }

              // PIDs limit
              if (args.pidsLimit !== undefined && args.pidsLimit !== null) {
                hostConfig.PidsLimit = args.pidsLimit === -1 ? 0 : args.pidsLimit;
              }

              // Shared memory size
              if (args.shmSize) {
                hostConfig.ShmSize = args.shmSize * 1024 * 1024; // Convert MB to bytes
              }

              // Init process
              if (args.init === true) {
                hostConfig.Init = true;
              }

              // Logging
              if (args.logDriver) {
                hostConfig.LogConfig = {
                  Type: args.logDriver,
                  Config: args.logOpts || {}
                };
              }

              // Custom network
              if (args.networkMode === 'container' && args.customNetwork) {
                hostConfig.NetworkMode = `container:${args.customNetwork}`;
              } else if (args.customNetwork && args.networkMode !== 'host' && args.networkMode !== 'none') {
                // Will be handled after container creation
              }

              containerConfig.HostConfig = hostConfig;

              // Create the container
              logger.info('Creating container', { name: args.containerName });
              const container = await docker.createContainer(containerConfig);

              // Connect to custom network if specified
              if (args.customNetwork && args.networkMode !== 'container' && args.networkMode !== 'host' && args.networkMode !== 'none') {
                try {
                  const network = docker.getNetwork(args.customNetwork);
                  await network.connect({ Container: container.id });
                  console.log(`[INFO] Connected container to network: ${args.customNetwork}`);
                } catch (netErr) {
                  console.warn(`[WARN] Failed to connect to network ${args.customNetwork}: ${netErr.message}`);
                }
              }

              // Start the container
              logger.info('Starting container', { name: args.containerName });
              await container.start();

              logger.info('Container deployed successfully', { name: args.containerName, image: args.image });

              // Respond with success message
              peer.write(
                JSON.stringify({
                  success: true,
                  message: `Container "${args.containerName}" deployed successfully from image "${args.image}"`,
                })
              );

              // Update all peers with the latest container list
              const containers = await docker.listContainers({ all: true });
              const update = { type: 'containers', data: containers };

              for (const connectedPeer of connectedPeers) {
                try {
                  connectedPeer.write(JSON.stringify(update));
                } catch (peerErr) {
                  console.error(`[ERROR] Failed to send update to peer: ${peerErr.message}`);
                }
              }
            } catch (err) {
              logger.error('Failed to deploy container', { error: err.message, containerName: args?.containerName });
              const errorResponse = createErrorResponse(err);
              errorResponse.error = sanitizeErrorMessage(errorResponse.error);
              peer.write(JSON.stringify(errorResponse));
            }
            break;



        case 'startTerminal':
          console.log(`[INFO] Starting terminal for container: ${parsedData.args.containerId}`);
          handleTerminal(parsedData.args.containerId, peer);
          return; // No immediate response needed for streaming commands

        case 'killTerminal':
          console.log(`[INFO] Handling 'killTerminal' command for container: ${parsedData.args.containerId}`);
          handleKillTerminal(parsedData.args.containerId, peer);
          response = {
            success: true,
            message: `Terminal for container ${parsedData.args.containerId} killed`,
          };
          break;

        case 'getSystemInfo':
          console.log('[INFO] Handling \'getSystemInfo\' command');
          try {
            const [info, version] = await Promise.all([
              docker.info(),
              docker.version()
            ]);
            response = { 
              type: 'systemInfo', 
              data: { info, version } 
            };
          } catch (error) {
            console.error(`[ERROR] Failed to get system info: ${error.message}`);
            response = { error: 'Failed to get system info' };
          }
          break;

        case 'listImages':
          console.log('[INFO] Handling \'listImages\' command');
          try {
            const images = await docker.listImages({ all: true });
            // Get container usage for each image
            const containers = await docker.listContainers({ all: true });
            const imageUsage = {};
            containers.forEach(container => {
              const imageId = container.ImageID;
              if (!imageUsage[imageId]) {
                imageUsage[imageId] = [];
              }
              imageUsage[imageId].push({
                id: container.Id,
                name: container.Names[0]?.replace(/^\//, '') || container.Id.substring(0, 12),
                state: container.State
              });
            });
            
            const imagesWithUsage = images.map(image => ({
              ...image,
              usage: imageUsage[image.Id] || []
            }));
            
            response = { type: 'images', data: imagesWithUsage };
          } catch (error) {
            console.error(`[ERROR] Failed to list images: ${error.message}`);
            response = { error: 'Failed to list images' };
          }
          break;

        case 'pullImage':
          console.log(`[INFO] Handling 'pullImage' command for image: ${parsedData.args.image}`);
          try {
            const imageName = validation.sanitizeString(parsedData.args.image, 255);
            if (!imageName || !validation.isValidImageName(imageName)) {
              throw new Error('Invalid image name');
            }
            
            const pullStream = await docker.pull(imageName);
            await new Promise((resolve, reject) => {
              docker.modem.followProgress(pullStream, (err) => {
                if (err) reject(err);
                else resolve();
              });
            });
            
            response = { success: true, message: `Image "${imageName}" pulled successfully` };
          } catch (error) {
            console.error(`[ERROR] Failed to pull image: ${error.message}`);
            response = { error: `Failed to pull image: ${error.message}` };
          }
          break;

        case 'removeImage':
          console.log(`[INFO] Handling 'removeImage' command for image: ${parsedData.args.id}`);
          try {
            const image = docker.getImage(parsedData.args.id);
            await image.remove({ force: parsedData.args.force || false });
            response = { success: true, message: `Image ${parsedData.args.id} removed` };
          } catch (error) {
            console.error(`[ERROR] Failed to remove image: ${error.message}`);
            response = { error: `Failed to remove image: ${error.message}` };
          }
          break;

        case 'inspectImage':
          console.log(`[INFO] Handling 'inspectImage' command for image: ${parsedData.args.id}`);
          try {
            const image = docker.getImage(parsedData.args.id);
            const imageData = await image.inspect();
            response = { type: 'imageConfig', data: imageData };
          } catch (error) {
            console.error(`[ERROR] Failed to inspect image: ${error.message}`);
            response = { error: `Failed to inspect image: ${error.message}` };
          }
          break;

        case 'buildImage':
          console.log(`[INFO] Handling 'buildImage' command`);
          try {
            const { dockerfile, tag } = parsedData.args;
            if (!dockerfile) {
              throw new Error('Dockerfile content required');
            }
            
            // For now, we'll need to create a tar stream manually or use a library
            // Since we don't have tar-stream in dependencies, we'll use a simpler approach
            // Build from a temporary Dockerfile string
            const buildOptions = {
              dockerfile: 'Dockerfile',
            };
            
            // Create a simple tar-like stream with just the Dockerfile
            // Note: This is a simplified implementation
            // In production, you'd want to use a proper tar library
            const DockerfileBuffer = Buffer.from(dockerfile);
            const tarHeader = Buffer.alloc(512);
            const name = 'Dockerfile';
            tarHeader.write(name, 0);
            tarHeader.write('100644', 156, 6); // file mode
            tarHeader.writeUInt32LE(DockerfileBuffer.length, 124); // size
            const checksum = tarHeader.slice(0, 148).reduce((sum, byte) => sum + byte, 0) + 
                            tarHeader.slice(156).reduce((sum, byte) => sum + byte, 0) + 
                            (32 * 8); // space for checksum
            tarHeader.write(checksum.toString(8).padStart(7, '0') + '\0', 148);
            
            const tarData = Buffer.concat([
              tarHeader,
              DockerfileBuffer,
              Buffer.alloc((512 - (DockerfileBuffer.length % 512)) % 512), // padding
              Buffer.alloc(1024) // end of tar
            ]);
            
            const buildOptionsWithTag = tag ? { ...buildOptions, t: tag } : buildOptions;
            const buildStream = await docker.buildImage(tarData, buildOptionsWithTag);
            
            let buildOutput = '';
            await new Promise((resolve, reject) => {
              docker.modem.followProgress(buildStream, (err, output) => {
                if (err) {
                  reject(err);
                } else {
                  if (output) {
                    buildOutput = output.map(o => o.stream || '').join('');
                  }
                  resolve(output);
                }
              }, (event) => {
                // Progress callback
                if (event.stream) {
                  console.log(`[BUILD] ${event.stream.trim()}`);
                }
              });
            });
            
            response = { success: true, message: `Image built successfully: ${tag || 'untagged:latest'}`, output: buildOutput };
          } catch (error) {
            console.error(`[ERROR] Failed to build image: ${error.message}`);
            response = { error: `Failed to build image: ${error.message}` };
          }
          break;

        case 'tagImage':
          console.log(`[INFO] Handling 'tagImage' command for image: ${parsedData.args.id}`);
          try {
            const image = docker.getImage(parsedData.args.id);
            const repo = validation.sanitizeString(parsedData.args.repo, 255);
            const tag = validation.sanitizeString(parsedData.args.tag || 'latest', 128);
            
            if (!repo) {
              throw new Error('Repository name required');
            }
            
            await image.tag({ repo, tag });
            response = { success: true, message: `Image tagged as ${repo}:${tag}` };
          } catch (error) {
            console.error(`[ERROR] Failed to tag image: ${error.message}`);
            response = { error: `Failed to tag image: ${error.message}` };
          }
          break;

        case 'listNetworks':
          console.log('[INFO] Handling \'listNetworks\' command');
          try {
            const networks = await docker.listNetworks();
            // Get container usage for each network
            const containers = await docker.listContainers({ all: true });
            const networkUsage = {};
            containers.forEach(container => {
              if (container.NetworkSettings && container.NetworkSettings.Networks) {
                Object.keys(container.NetworkSettings.Networks).forEach(networkName => {
                  if (!networkUsage[networkName]) {
                    networkUsage[networkName] = [];
                  }
                  networkUsage[networkName].push({
                    id: container.Id,
                    name: container.Names[0]?.replace(/^\//, '') || container.Id.substring(0, 12),
                    state: container.State
                  });
                });
              }
            });
            
            const networksWithUsage = networks.map(network => ({
              ...network,
              usage: networkUsage[network.Name] || []
            }));
            
            response = { type: 'networks', data: networksWithUsage };
          } catch (error) {
            console.error(`[ERROR] Failed to list networks: ${error.message}`);
            response = { error: 'Failed to list networks' };
          }
          break;

        case 'createNetwork':
          console.log('[INFO] Handling \'createNetwork\' command');
          try {
            const args = parsedData.args;
            const networkConfig = {
              Name: validation.sanitizeString(args.name, 128),
              Driver: args.driver || 'bridge',
              CheckDuplicate: true
            };
            
            if (args.subnet) networkConfig.IPAM = {
              Config: [{ Subnet: args.subnet }]
            };
            
            if (args.options && typeof args.options === 'object') {
              networkConfig.Options = args.options;
            }
            
            const network = await docker.createNetwork(networkConfig);
            response = { success: true, message: `Network "${args.name}" created successfully`, data: network.id };
          } catch (error) {
            console.error(`[ERROR] Failed to create network: ${error.message}`);
            response = { error: `Failed to create network: ${error.message}` };
          }
          break;

        case 'removeNetwork':
          console.log(`[INFO] Handling 'removeNetwork' command for network: ${parsedData.args.id}`);
          try {
            const network = docker.getNetwork(parsedData.args.id);
            await network.remove();
            response = { success: true, message: `Network ${parsedData.args.id} removed` };
          } catch (error) {
            console.error(`[ERROR] Failed to remove network: ${error.message}`);
            response = { error: `Failed to remove network: ${error.message}` };
          }
          break;

        case 'inspectNetwork':
          console.log(`[INFO] Handling 'inspectNetwork' command for network: ${parsedData.args.id}`);
          try {
            const network = docker.getNetwork(parsedData.args.id);
            const networkData = await network.inspect();
            response = { type: 'networkConfig', data: networkData };
          } catch (error) {
            console.error(`[ERROR] Failed to inspect network: ${error.message}`);
            response = { error: `Failed to inspect network: ${error.message}` };
          }
          break;

        case 'connectNetwork':
          console.log(`[INFO] Handling 'connectNetwork' command`);
          try {
            const network = docker.getNetwork(parsedData.args.networkId);
            await network.connect({ Container: parsedData.args.containerId });
            response = { success: true, message: `Container connected to network` };
          } catch (error) {
            console.error(`[ERROR] Failed to connect container to network: ${error.message}`);
            response = { error: `Failed to connect container to network: ${error.message}` };
          }
          break;

        case 'disconnectNetwork':
          console.log(`[INFO] Handling 'disconnectNetwork' command`);
          try {
            const network = docker.getNetwork(parsedData.args.networkId);
            await network.disconnect({ Container: parsedData.args.containerId, Force: parsedData.args.force || false });
            response = { success: true, message: `Container disconnected from network` };
          } catch (error) {
            console.error(`[ERROR] Failed to disconnect container from network: ${error.message}`);
            response = { error: `Failed to disconnect container from network: ${error.message}` };
          }
          break;

        case 'listVolumes':
          console.log('[INFO] ===== Handling \'listVolumes\' command =====');
          try {
            // Directly call Docker API via socket - dockerode handles the socket communication
            const volumesResult = await docker.listVolumes();
            
            // Docker API returns { Volumes: [...], Warnings: [...] }
            // Extract volumes list from Docker socket API response
            const volumesList = extractVolumesList(volumesResult);
            
            console.log(`[INFO] Retrieved ${volumesList.length} volumes from Docker socket API`);
            
            // Return consistent format with type field for volumes tab
            // Also include success/volumes for backwards compatibility with selector
            response = { 
              type: 'volumes', 
              data: volumesList,
              success: true, 
              volumes: volumesList 
            };
          } catch (error) {
            console.error(`[ERROR] ===== Failed to list volumes from Docker socket API =====`);
            console.error(`[ERROR] Error message: ${error.message}`);
            console.error(`[ERROR] Error stack:`, error.stack);
            response = { 
              type: 'volumes',
              success: false, 
              error: `Failed to list volumes: ${error.message}`,
              data: [],
              volumes: []
            };
          }
          break;

        case 'createVolume':
          console.log('[INFO] Handling \'createVolume\' command');
          try {
            const args = parsedData.args;
            const volumeConfig = {
              Name: validation.sanitizeString(args.name, 128)
            };
            
            if (args.driver) volumeConfig.Driver = args.driver;
            if (args.options && typeof args.options === 'object') {
              volumeConfig.DriverOpts = args.options;
            };
            
            const volume = await docker.createVolume(volumeConfig);
            response = { success: true, message: `Volume "${args.name}" created successfully`, data: volume.name };
            
            // Broadcast updated volumes list to all peers
            try {
              const volumesResult = await docker.listVolumes();
              // Handle both direct array response and object with Volumes property
              let volumesList = [];
              if (Array.isArray(volumesResult)) {
                volumesList = volumesResult;
              } else if (volumesResult && Array.isArray(volumesResult.Volumes)) {
                volumesList = volumesResult.Volumes;
              } else if (volumesResult && volumesResult.volumes && Array.isArray(volumesResult.volumes)) {
                volumesList = volumesResult.volumes;
              }
              
              const update = { 
                type: 'volumes', 
                data: volumesList,
                success: true,
                volumes: volumesList
              };
              
              for (const connectedPeer of connectedPeers) {
                try {
                  connectedPeer.write(JSON.stringify(update));
                } catch (peerErr) {
                  console.error(`[ERROR] Failed to send volume update to peer: ${peerErr.message}`);
                }
              }
            } catch (volErr) {
              console.warn(`[WARN] Failed to broadcast volume update: ${volErr.message}`);
            }
          } catch (error) {
            console.error(`[ERROR] Failed to create volume: ${error.message}`);
            response = { error: `Failed to create volume: ${error.message}` };
          }
          break;

        case 'removeVolume':
          console.log(`[INFO] Handling 'removeVolume' command for volume: ${parsedData.args.name}`);
          try {
            const volume = docker.getVolume(parsedData.args.name);
            await volume.remove();
            response = { success: true, message: `Volume ${parsedData.args.name} removed` };
            
            // Broadcast updated volumes list to all peers
            try {
              const volumesResult = await docker.listVolumes();
              // Handle both direct array response and object with Volumes property
              let volumesList = [];
              if (Array.isArray(volumesResult)) {
                volumesList = volumesResult;
              } else if (volumesResult && Array.isArray(volumesResult.Volumes)) {
                volumesList = volumesResult.Volumes;
              } else if (volumesResult && volumesResult.volumes && Array.isArray(volumesResult.volumes)) {
                volumesList = volumesResult.volumes;
              }
              
              const update = { 
                type: 'volumes', 
                data: volumesList,
                success: true,
                volumes: volumesList
              };
              
              for (const connectedPeer of connectedPeers) {
                try {
                  connectedPeer.write(JSON.stringify(update));
                } catch (peerErr) {
                  console.error(`[ERROR] Failed to send volume update to peer: ${peerErr.message}`);
                }
              }
            } catch (volErr) {
              console.warn(`[WARN] Failed to broadcast volume update: ${volErr.message}`);
            }
          } catch (error) {
            console.error(`[ERROR] Failed to remove volume: ${error.message}`);
            response = { error: `Failed to remove volume: ${error.message}` };
          }
          break;

        case 'inspectVolume':
          console.log(`[INFO] Handling 'inspectVolume' command for volume: ${parsedData.args.name}`);
          try {
            const volume = docker.getVolume(parsedData.args.name);
            const volumeData = await volume.inspect();
            response = { type: 'volumeConfig', data: volumeData };
          } catch (error) {
            console.error(`[ERROR] Failed to inspect volume: ${error.message}`);
            response = { error: `Failed to inspect volume: ${error.message}` };
          }
          break;

        case 'getDockerEvents':
          console.log('[INFO] Handling \'getDockerEvents\' command');
          try {
            // Return recent events (last 100)
            // Note: For real-time events, we already have initializeDockerEventStream
            // This is for fetching historical events
            response = { 
              type: 'dockerEvents', 
              data: [],
              note: 'Real-time events are already streamed. Historical events require Docker API enhancement.'
            };
          } catch (error) {
            console.error(`[ERROR] Failed to get Docker events: ${error.message}`);
            response = { error: `Failed to get Docker events: ${error.message}` };
          }
          break;

        case 'deployStack':
          console.log('[INFO] Handling \'deployStack\' command');
          try {
            const { composeContent, stackName } = parsedData.args;
            if (!composeContent || !stackName) {
              throw new Error('Compose content and stack name required');
            }
            const sanitizedStackName = validation.sanitizeString(stackName, 63);
            const result = await composeManager.deployComposeStack(docker, composeContent, sanitizedStackName);
            response = { success: true, ...result };
            
            // Update container list for all peers
            const containers = await docker.listContainers({ all: true });
            const update = { type: 'containers', data: containers };
            for (const connectedPeer of connectedPeers) {
              try {
                connectedPeer.write(JSON.stringify(update));
              } catch (peerErr) {
                console.error(`[ERROR] Failed to send update to peer: ${peerErr.message}`);
              }
            }
          } catch (error) {
            console.error(`[ERROR] Failed to deploy stack: ${error.message}`);
            response = { error: `Failed to deploy stack: ${error.message}` };
          }
          break;

        case 'listStacks':
          console.log('[INFO] Handling \'listStacks\' command');
          try {
            const stacks = await composeManager.listStacks(docker);
            response = { type: 'stacks', data: stacks };
          } catch (error) {
            console.error(`[ERROR] Failed to list stacks: ${error.message}`);
            response = { error: `Failed to list stacks: ${error.message}` };
          }
          break;

        case 'removeStack':
          console.log(`[INFO] Handling 'removeStack' command for stack: ${parsedData.args.stackName}`);
          try {
            const result = await composeManager.removeComposeStack(docker, parsedData.args.stackName);
            response = { success: true, ...result };
            
            // Update container list for all peers
            const containers = await docker.listContainers({ all: true });
            const update = { type: 'containers', data: containers };
            for (const connectedPeer of connectedPeers) {
              try {
                connectedPeer.write(JSON.stringify(update));
              } catch (peerErr) {
                console.error(`[ERROR] Failed to send update to peer: ${peerErr.message}`);
              }
            }
          } catch (error) {
            console.error(`[ERROR] Failed to remove stack: ${error.message}`);
            response = { error: `Failed to remove stack: ${error.message}` };
          }
          break;

        case 'browseDirectory':
          console.log(`[INFO] Handling 'browseDirectory' command for path: ${parsedData.args?.path || '/'}`);
          try {
            const requestedPath = parsedData.args?.path || '/';
            
            // Validate path
            if (!validation.isValidDirectoryPath(requestedPath)) {
              console.error(`[ERROR] Invalid directory path: ${requestedPath}`);
              throw new Error('Invalid directory path');
            }
            
            // Sanitize path
            const safePath = validation.sanitizeDirectoryPath(requestedPath);
            
            // Verify the path exists and is a directory
            try {
              const stats = fs.statSync(safePath);
              if (!stats.isDirectory()) {
                throw new Error('Not a directory: The specified path is not a directory');
              }
            } catch (statError) {
              if (statError.code === 'ENOENT') {
                throw new Error('Directory not found: The specified path does not exist');
              } else if (statError.code === 'EACCES') {
                throw new Error('Permission denied: You do not have permission to access this directory');
              }
              throw statError;
            }
            
            // Read directory contents
            const contents = [];
            try {
              const items = fs.readdirSync(safePath, { withFileTypes: true });
              
              for (const item of items) {
                try {
                  const itemPath = path.join(safePath, item.name);
                  const stats = fs.statSync(itemPath);
                  
                  contents.push({
                    name: item.name,
                    type: item.isDirectory() ? 'directory' : 'file',
                    size: stats.size,
                    modified: stats.mtime.toISOString(),
                    permissions: stats.mode.toString(8).slice(-3)
                  });
                } catch (statError) {
                  // Skip items we can't stat (permissions, etc.)
                  console.warn(`[WARN] Could not stat ${item.name}: ${statError.message}`);
                }
              }
              
              response = { success: true, contents, path: safePath };
            } catch (readError) {
              console.error(`[ERROR] Failed to read directory "${safePath}":`, readError);
              if (readError.code === 'EACCES') {
                throw new Error('Permission denied: You do not have permission to access this directory');
              } else if (readError.code === 'ENOENT') {
                throw new Error('Directory not found: The specified path does not exist');
              } else if (readError.code === 'ENOTDIR') {
                throw new Error('Not a directory: The specified path is not a directory');
              } else {
                throw new Error(`Failed to read directory: ${readError.message}`);
              }
            }
          } catch (error) {
            console.error(`[ERROR] Failed to browse directory: ${error.message}`);
            response = { success: false, error: error.message };
          }
          break;

        default:
          console.warn(`[WARN] Unknown command: ${parsedData.command}`);
          return;
      }

      // Send response if one was generated
      if (response) {
        const responseStr = JSON.stringify(response);
        try {
          peer.write(responseStr);
        } catch (writeError) {
          console.error(`[ERROR] Failed to write response to peer:`, writeError.message);
        }
      } else {
        console.warn(`[WARN] No response generated for command: ${parsedData.command}`);
      }
    } catch (err) {
      logger.error('Failed to handle data from peer', { error: err.message, command: parsedData?.command || 'unknown' });
      // Sanitize error messages to prevent information leakage
      const errorMessage = err.message.includes('ENOENT') || err.message.includes('EACCES') 
        ? 'Operation failed. Please check permissions and try again.'
        : err.message.length > 200 
          ? 'An error occurred. Please try again.'
          : err.message;
      peer.write(JSON.stringify({ 
        error: errorMessage,
        code: err.code || 'UNKNOWN_ERROR'
      }));
    }
  });

  peer.on('error', (err) => {
    logger.error('Peer connection error', { error: err.message });
    cleanupPeer(peer);
  });

  peer.on('close', () => {
    logger.info('Peer disconnected');
    connectedPeers.delete(peer);
    cleanupPeer(peer)

    // Clean up any terminal session associated with this peer
    if (terminalSessions.has(peer)) {
      const session = terminalSessions.get(peer);
      console.log(`[INFO] Cleaning up terminal session for container: ${session.containerId}`);
      session.stream.end();
      peer.removeListener('data', session.onData);
      terminalSessions.delete(peer);
    }
  });
});

// Helper function to handle peer cleanup
function cleanupPeer(peer) {
  connectedPeers.delete(peer);

  if (terminalSessions.has(peer)) {
    const session = terminalSessions.get(peer);
    console.log(`[INFO] Cleaning up terminal session for container: ${session.containerId}`);
    session.stream.end();
    peer.removeListener('data', session.onData);
    terminalSessions.delete(peer);
  }

  // Clean up all logs streams for this peer
  const peerId = peer.remotePublicKey?.toString('hex') || 'unknown';
  const logsKeysToDelete = [];
  for (const [key, stream] of logsStreams.entries()) {
    if (key.startsWith(`${peerId}:`)) {
      try {
        stream.destroy();
        console.log(`[INFO] Destroyed logs stream: ${key}`);
      } catch (err) {
        console.error(`[ERROR] Failed to destroy logs stream ${key}: ${err.message}`);
      }
      logsKeysToDelete.push(key);
    }
  }
  logsKeysToDelete.forEach(key => logsStreams.delete(key));
}

// Function to duplicate a container
async function duplicateContainer(name, image, hostname, netmode, cpu, memory, config, peer) {
  try {
    // Remove non-essential fields from the configuration
    const sanitizedConfig = { ...config };
    delete sanitizedConfig.Id;
    delete sanitizedConfig.State;
    delete sanitizedConfig.Created;
    delete sanitizedConfig.NetworkSettings;
    delete sanitizedConfig.Mounts;
    delete sanitizedConfig.Path;
    delete sanitizedConfig.Args;
    delete sanitizedConfig.Image;
    delete sanitizedConfig.Hostname;
    delete sanitizedConfig.CpuCount;
    delete sanitizedConfig.Memory;
    delete sanitizedConfig.CpuShares;
    delete sanitizedConfig.CpusetCpus;



    // Ensure the container has a unique name
    const newName = name;
    const existingContainers = await docker.listContainers({ all: true });
    const nameExists = existingContainers.some(c => c.Names.includes(`/${newName}`));

    if (nameExists) {
      peer.write(JSON.stringify({ error: `Container name '${newName}' already exists.` }));
      return;
    }


    const cpusetCpus = Array.from({ length: cpu }, (_, i) => i).join(",");
    const nanoCpus = cpu * 1e9;

    // Create a new container with the provided configuration
    const newContainer = await docker.createContainer({
      ...sanitizedConfig.Config, // General configuration
      name: newName,            // Container name
      Hostname: hostname,       // Hostname for the container
      Image: image,             // Container image
      HostConfig: {             // Host-specific configurations
        CpusetCpus: cpusetCpus.toString(),          // Number of CPUs
        NanoCpus: nanoCpus,     // Restrict CPU time (e.g., 4 cores = 4e9 nanoseconds)
        Memory: Number(memory),         // Memory limit in bytes
        MemoryReservation: Number(memory),         // Memory limit in bytes

        NetworkMode: netmode.toString(),   // Network mode
      },
    });
    // Start the new container
    await newContainer.start();

    // Send success response to the requesting peer
    peer.write(JSON.stringify({ success: true, message: `Container '${newName}' duplicated and started successfully.` }));

    // Get the updated list of containers
    const containers = await docker.listContainers({ all: true });
    const update = { type: 'containers', data: containers };

    // Broadcast the updated container list to all connected peers
    for (const connectedPeer of connectedPeers) {
      connectedPeer.write(JSON.stringify(update));
    }

    // Start streaming stats for the new container
    const newContainerInfo = containers.find(c => c.Names.includes(`/${newName}`));
    if (newContainerInfo) {
      streamContainerStats(newContainerInfo);
    }
  } catch (err) {
    console.error(`[ERROR] Failed to duplicate container: ${err.message}`);
    peer.write(JSON.stringify({ error: `Failed to duplicate container: ${err.message}` }));
  }
}


// Stream Docker events to all peers
let dockerEventStream = null;

async function initializeDockerEventStream() {
  try {
    const stream = await new Promise((resolve, reject) => {
      docker.getEvents({}, (err, stream) => {
        if (err) {
          reject(err);
        } else {
          resolve(stream);
        }
      });
    });

    dockerEventStream = stream; // Store reference for cleanup

    stream.on('data', async (chunk) => {
      try {
        const event = JSON.parse(chunk.toString());
        if (event.status === "undefined") return;
        logger.info('Docker event received', { status: event.status, id: event.id, type: event.Type });

        // Handle container events
        if (event.Type === 'container') {
          // Get updated container list and broadcast it to all connected peers
          const containers = await docker.listContainers({ all: true });
          const update = { type: 'containers', data: containers };

          for (const peer of connectedPeers) {
            try {
              peer.write(JSON.stringify(update));
            } catch (peerErr) {
              logger.error('Failed to send update to peer', { error: peerErr.message });
            }
          }
        }
        
        // Handle volume events (create, destroy)
        if (event.Type === 'volume' && (event.Action === 'create' || event.Action === 'destroy')) {
          try {
            const volumesResult = await docker.listVolumes();
            // Extract volumes list from Docker socket API response
            const volumesList = extractVolumesList(volumesResult);
            
            const update = { 
              type: 'volumes', 
              data: volumesList,
              success: true,
              volumes: volumesList
            };

            for (const peer of connectedPeers) {
              try {
                peer.write(JSON.stringify(update));
              } catch (peerErr) {
                logger.error('Failed to send volume update to peer', { error: peerErr.message });
              }
            }
          } catch (volErr) {
            logger.error('Failed to fetch volumes after event', { error: volErr.message });
          }
        }
      } catch (err) {
        logger.error('Failed to process Docker event', { error: err.message });
      }
    });

    stream.on('error', (err) => {
      logger.error('Docker event stream error', { error: err.message });
    });

    stream.on('end', () => {
      logger.info('Docker event stream ended');
      dockerEventStream = null;
    });
  } catch (err) {
    logger.error('Failed to get Docker events', { error: err.message });
  }
}

// Initialize Docker event stream
initializeDockerEventStream();

// Collect and stream container stats (async/await version)
async function initializeContainerStatsCollection() {
  try {
    const containers = await docker.listContainers({ all: true });
    
    // Iterate over all containers
    for (const containerInfo of containers) {
      const container = docker.getContainer(containerInfo.Id);
      
      try {
        // Use the same logic as listContainers to pre-inspect and extract the IP address
        const details = await container.inspect();
        let ipAddress = 'No IP Assigned'; // Default fallback

        if (details.NetworkSettings && details.NetworkSettings.Networks) {
          const networks = Object.values(details.NetworkSettings.Networks);
          if (networks.length > 0 && networks[0].IPAddress) {
            ipAddress = networks[0].IPAddress; // Use the first network's IP
          }
        }
      } catch (inspectErr) {
        logger.debug('Failed to inspect container for IP', { containerId: containerInfo.Id, error: inspectErr.message });
      }
    }
  } catch (err) {
    logger.error('Failed to list containers for stats', { error: err.message });
  }
}

// Initialize container stats collection
initializeContainerStatsCollection();

// Function to calculate CPU usage percentage
function calculateCPUPercent(stats) {
  try {
    // Validate required stats structure
    if (!stats || !stats.cpu_stats || !stats.precpu_stats || 
        !stats.cpu_stats.cpu_usage || !stats.precpu_stats.cpu_usage) {
      return 0.0;
    }

    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    
    // Safely determine CPU count with multiple fallbacks
    let cpuCount = 1; // Default to 1 CPU
    if (stats.cpu_stats.online_cpus) {
      cpuCount = stats.cpu_stats.online_cpus;
    } else if (stats.cpu_stats.cpu_usage.percpu_usage && Array.isArray(stats.cpu_stats.cpu_usage.percpu_usage)) {
      cpuCount = stats.cpu_stats.cpu_usage.percpu_usage.length;
    }
    
    if (systemDelta > 0.0 && cpuDelta > 0.0) {
      return (cpuDelta / systemDelta) * cpuCount * 100.0;
    }
    return 0.0;
  } catch (err) {
    console.error(`[ERROR] Failed to calculate CPU percent: ${err.message}`);
    return 0.0;
  }
}

// Function to handle terminal sessions
// Function to handle terminal sessions
async function handleTerminal(containerId, peer) {
  const container = docker.getContainer(containerId);

  try {
    const exec = await container.exec({
      Cmd: ['/bin/bash'],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    });

    const stream = await exec.start({ hijack: true, stdin: true });

    console.log(`[INFO] Terminal session started for container: ${containerId}`);

    const stdout = new PassThrough();
    const stderr = new PassThrough();

    container.modem.demuxStream(stream, stdout, stderr);

    const onData = (input) => {
      try {
        const parsed = JSON.parse(input.toString());
        if (parsed.type === 'terminalInput' && parsed.data) {
          const inputData = parsed.encoding === 'base64'
            ? Buffer.from(parsed.data, 'base64')
            : Buffer.from(parsed.data);
          stream.write(inputData);
        } else if (parsed.type === 'terminalResize' && parsed.containerId === containerId) {
          // Handle terminal resize
          if (parsed.cols && parsed.rows && parsed.cols > 0 && parsed.rows > 0) {
            try {
              exec.resize({ h: parsed.rows, w: parsed.cols });
              console.log(`[INFO] Terminal resized for container ${containerId}: ${parsed.cols}x${parsed.rows}`);
            } catch (resizeErr) {
              console.error(`[ERROR] Failed to resize terminal: ${resizeErr.message}`);
            }
          }
        }
      } catch (err) {
        console.error(`[ERROR] Failed to parse terminal input: ${err.message}`);
      }
    };

    peer.on('data', onData);
    terminalSessions.set(peer, { containerId, exec, stream, onData });

    stdout.on('data', (chunk) => {
      peer.write(JSON.stringify({
        type: 'terminalOutput',
        containerId,
        data: chunk.toString('base64'),
        encoding: 'base64',
      }));
    });

    stderr.on('data', (chunk) => {
      peer.write(JSON.stringify({
        type: 'terminalErrorOutput',
        containerId,
        data: chunk.toString('base64'),
        encoding: 'base64',
      }));
    });

    peer.on('close', () => {
      console.log(`[INFO] Peer disconnected, ending terminal session for container: ${containerId}`);
      stream.end();
      terminalSessions.delete(peer);
      peer.removeListener('data', onData);
    });
  } catch (err) {
    console.error(`[ERROR] Failed to start terminal for container ${containerId}: ${err.message}`);
    peer.write(JSON.stringify({ error: `Failed to start terminal: ${err.message}` }));
  }
}


// Function to handle killing terminal sessions
function handleKillTerminal(containerId, peer) {
  const session = terminalSessions.get(peer);

  if (session && session.containerId === containerId) {
    console.log(`[INFO] Killing terminal session for container: ${containerId}`);

    // Close the stream and exec session
    session.stream.end();
    terminalSessions.delete(peer);

    // Remove the specific 'data' event listener for terminal input
    peer.removeListener('data', session.onData);

    console.log(`[INFO] Terminal session for container ${containerId} terminated`);
  } else {
    console.warn(`[WARN] No terminal session found for container: ${containerId}`);
  }
}

async function collectContainerStats(containerStats) {
  try {
    const currentContainers = await docker.listContainers({ all: true });
    const currentIds = currentContainers.map((c) => c.Id);

    // Collect stats for all containers, including newly added ones
    for (const containerInfo of currentContainers) {
      if (!containerStats[containerInfo.Id]) {
        try {
          console.log(`[INFO] Found new container: ${containerInfo.Names[0]?.replace(/^\//, '')}`);
          containerStats[containerInfo.Id] = await initializeContainerStats(containerInfo);
        } catch (err) {
          console.error(`[ERROR] Failed to initialize stats for container ${containerInfo.Id}: ${err.message}`);
        }
      }
    }

    // Remove containers that no longer exist
    Object.keys(containerStats).forEach((id) => {
      if (!currentIds.includes(id)) {
        console.log(`[INFO] Removing stats tracking for container: ${id}`);
        const statsData = containerStats[id];
        // Clean up stats stream if it exists
        if (statsData && statsData.stream) {
          try {
            statsData.stream.destroy();
            console.log(`[INFO] Destroyed stats stream for container: ${id}`);
          } catch (err) {
            console.error(`[ERROR] Failed to destroy stats stream for container ${id}: ${err.message}`);
          }
        }
        delete containerStats[id];
      }
    });

    return containerStats;
  } catch (err) {
    console.error(`[ERROR] Failed to collect container stats: ${err.message}`);
    return containerStats; // Return existing stats on error
  }
}

async function initializeContainerStats(containerInfo) {
  const container = docker.getContainer(containerInfo.Id);

  // Inspect container for IP address
  let ipAddress = 'No IP Assigned';
  try {
    const details = await container.inspect();
    const networks = details.NetworkSettings?.Networks || {};
    ipAddress = Object.values(networks)[0]?.IPAddress || 'No IP Assigned';
  } catch (err) {
    console.error(`[ERROR] Failed to inspect container ${containerInfo.Id}: ${err.message}`);
  }

  const statsData = {
    id: containerInfo.Id,
    name: containerInfo.Names[0]?.replace(/^\//, '') || 'Unknown',
    cpu: 0,
    memory: 0,
    ip: ipAddress,
    stream: null, // Store stream reference for cleanup
  };

  // Start streaming stats for the container
  try {
    const statsStream = await container.stats({ stream: true });
    statsData.stream = statsStream; // Store reference
    
    statsStream.on('data', (data) => {
      try {
        const stats = JSON.parse(data.toString());
        statsData.cpu = calculateCPUPercent(stats);
        statsData.memory = stats.memory_stats.usage || 0;
      } catch (err) {
        console.error(`[ERROR] Failed to parse stats for container ${containerInfo.Id}: ${err.message}`);
      }
    });

    statsStream.on('error', (err) => {
      console.error(`[ERROR] Stats stream error for container ${containerInfo.Id}: ${err.message}`);
    });

    statsStream.on('close', () => {
      console.log(`[INFO] Stats stream closed for container ${containerInfo.Id}`);
      statsData.stream = null; // Clear reference when closed
    });
  } catch (err) {
    console.error(`[ERROR] Failed to start stats stream for container ${containerInfo.Id}: ${err.message}`);
  }

  return statsData;
}

// Stats cache with TTL
const statsCache = new Map();
const STATS_CACHE_TTL = 1000; // 1 second cache TTL
const STATS_BROADCAST_INTERVAL = 2000; // 2 seconds broadcast interval

// Track container activity for adaptive polling
const containerActivity = new Map(); // containerId -> lastActivity timestamp

/**
 * Determine if container is active based on CPU/memory usage
 * @param {Object} statsData - Container stats data
 * @returns {boolean} - True if container is considered active
 */
function isContainerActive(statsData) {
  const cpuThreshold = 1.0; // 1% CPU threshold
  const memoryThreshold = 1024 * 1024; // 1MB memory threshold
  
  return statsData.cpu > cpuThreshold || statsData.memory > memoryThreshold;
}

/**
 * Update container activity tracking
 * @param {string} containerId - Container ID
 * @param {Object} statsData - Container stats data
 */
function updateContainerActivity(containerId, statsData) {
  if (isContainerActive(statsData)) {
    containerActivity.set(containerId, Date.now());
  }
}

/**
 * Check if stats are cached and still valid
 * @param {string} containerId - Container ID
 * @returns {Object|null} - Cached stats or null
 */
function getCachedStats(containerId) {
  const cached = statsCache.get(containerId);
  if (cached && (Date.now() - cached.timestamp) < STATS_CACHE_TTL) {
    return cached.data;
  }
  return null;
}

/**
 * Cache stats data
 * @param {string} containerId - Container ID
 * @param {Object} statsData - Stats data to cache
 */
function cacheStats(containerId, statsData) {
  statsCache.set(containerId, {
    data: { ...statsData },
    timestamp: Date.now()
  });
}

async function handleStatsBroadcast() {
  const containerStats = {};
  let lastBroadcast = Date.now();

  // Periodically update stats and broadcast
  setInterval(async () => {
    try {
      await collectContainerStats(containerStats);
      
      const now = Date.now();
      const timeSinceLastBroadcast = now - lastBroadcast;
      
      // Only broadcast if enough time has passed
      if (timeSinceLastBroadcast >= STATS_BROADCAST_INTERVAL) {
        // Create clean stats objects without stream references for serialization
        const aggregatedStats = [];
        
        for (const [containerId, statsData] of Object.entries(containerStats)) {
          // Check cache first
          const cached = getCachedStats(containerId);
          if (cached && !isContainerActive(statsData)) {
            // Use cached data for inactive containers
            aggregatedStats.push(cached);
            continue;
          }
          
          // Update activity tracking
          updateContainerActivity(containerId, statsData);
          
          // Create stats object
          const statsObj = {
            id: statsData.id,
            name: statsData.name,
            cpu: statsData.cpu,
            memory: statsData.memory,
            ip: statsData.ip
          };
          
          // Cache the stats
          cacheStats(containerId, statsObj);
          aggregatedStats.push(statsObj);
        }
        
        // Only broadcast if there are stats to send and peers connected
        if (aggregatedStats.length > 0 && connectedPeers.size > 0) {
          const response = { type: 'allStats', data: aggregatedStats };

          for (const peer of connectedPeers) {
            try {
              peer.write(JSON.stringify(response));
            } catch (err) {
              console.error(`[ERROR] Failed to send stats to peer: ${err.message}`);
            }
          }
          
          lastBroadcast = now;
        }
      }
      
      // Clean up old cache entries
      for (const [containerId, cached] of statsCache.entries()) {
        if ((now - cached.timestamp) > STATS_CACHE_TTL * 10) {
          statsCache.delete(containerId);
        }
      }
      
      // Clean up old activity tracking
      const activityTimeout = 60000; // 1 minute
      for (const [containerId, lastActivity] of containerActivity.entries()) {
        if ((now - lastActivity) > activityTimeout) {
          containerActivity.delete(containerId);
        }
      }
    } catch (err) {
      console.error(`[ERROR] Failed to collect/broadcast stats: ${err.message}`);
    }
  }, 1000); // Check every second, but broadcast based on interval
}

// Start the stats broadcast
handleStatsBroadcast();



// Handle process termination
process.on('SIGINT', () => {
  console.log('[INFO] Server shutting down');
  
  // Clean up Docker event stream
  if (dockerEventStream) {
    try {
      dockerEventStream.destroy();
    } catch (err) {
      console.error(`[ERROR] Failed to destroy Docker event stream: ${err.message}`);
    }
  }
  
  // Clean up all peer connections
  for (const peer of connectedPeers) {
    try {
      cleanupPeer(peer);
    } catch (err) {
      console.error(`[ERROR] Failed to cleanup peer: ${err.message}`);
    }
  }
  
  swarm.destroy();
  process.exit();
});
