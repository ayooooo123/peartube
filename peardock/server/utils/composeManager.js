// composeManager.js
// Utility for managing Docker Compose deployments

import Docker from 'dockerode';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import logger from './logger.js';

/**
 * Parse docker-compose.yml content and extract service definitions
 * @param {string} composeContent - YAML content of docker-compose.yml
 * @returns {Object} Parsed compose structure
 */
export function parseComposeFile(composeContent) {
  // Simple YAML parser for basic compose files
  // For production, consider using js-yaml library
  const services = {};
  const lines = composeContent.split('\n');
  let currentService = null;
  let inService = false;
  let indentLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    // Detect services section
    if (line === 'services:' || line.startsWith('services:')) {
      inService = true;
      continue;
    }

    if (inService) {
      // Service name (no indentation after services:)
      if (!line.includes(':') && !line.startsWith('-')) {
        const serviceName = line.replace(':', '').trim();
        if (serviceName && !serviceName.includes(' ')) {
          currentService = serviceName;
          services[currentService] = {
            name: currentService,
            image: null,
            ports: [],
            volumes: [],
            environment: [],
            networks: [],
            depends_on: [],
            restart: 'no',
            command: null,
            entrypoint: null,
          };
        }
      } else if (currentService && line.includes(':')) {
        const [key, ...valueParts] = line.split(':');
        const keyName = key.trim();
        const value = valueParts.join(':').trim();

        switch (keyName) {
          case 'image':
            services[currentService].image = value;
            break;
          case 'restart':
            services[currentService].restart = value;
            break;
          case 'command':
            services[currentService].command = value.replace(/^["']|["']$/g, '');
            break;
          case 'entrypoint':
            services[currentService].entrypoint = value.replace(/^["']|["']$/g, '');
            break;
        }
      } else if (currentService && (line.startsWith('-') || line.includes(':'))) {
        // Handle array items
        if (line.includes('ports:')) {
          // Next lines will be port mappings
          let j = i + 1;
          while (j < lines.length && (lines[j].trim().startsWith('-') || lines[j].trim().startsWith('"'))) {
            const portLine = lines[j].trim().replace(/^-\s*/, '').replace(/^["']|["']$/g, '');
            if (portLine && portLine.includes(':')) {
              services[currentService].ports.push(portLine);
            }
            j++;
          }
          i = j - 1;
        } else if (line.includes('volumes:')) {
          let j = i + 1;
          while (j < lines.length && (lines[j].trim().startsWith('-') || lines[j].trim().startsWith('"'))) {
            const volLine = lines[j].trim().replace(/^-\s*/, '').replace(/^["']|["']$/g, '');
            if (volLine) {
              services[currentService].volumes.push(volLine);
            }
            j++;
          }
          i = j - 1;
        } else if (line.includes('environment:')) {
          let j = i + 1;
          while (j < lines.length && (lines[j].trim().startsWith('-') || lines[j].trim().startsWith('"'))) {
            const envLine = lines[j].trim().replace(/^-\s*/, '').replace(/^["']|["']$/g, '');
            if (envLine && envLine.includes('=')) {
              services[currentService].environment.push(envLine);
            }
            j++;
          }
          i = j - 1;
        } else if (line.includes('networks:')) {
          let j = i + 1;
          while (j < lines.length && (lines[j].trim().startsWith('-') || lines[j].trim().startsWith('"'))) {
            const netLine = lines[j].trim().replace(/^-\s*/, '').replace(/^["']|["']$/g, '');
            if (netLine) {
              services[currentService].networks.push(netLine);
            }
            j++;
          }
          i = j - 1;
        } else if (line.includes('depends_on:')) {
          let j = i + 1;
          while (j < lines.length && (lines[j].trim().startsWith('-') || lines[j].trim().startsWith('"'))) {
            const depLine = lines[j].trim().replace(/^-\s*/, '').replace(/^["']|["']$/g, '');
            if (depLine) {
              services[currentService].depends_on.push(depLine);
            }
            j++;
          }
          i = j - 1;
        }
      }
    }
  }

  return { services, version: '3' };
}

/**
 * Deploy a Docker Compose stack
 * @param {Docker} docker - Dockerode instance
 * @param {string} composeContent - YAML content
 * @param {string} stackName - Name of the stack
 * @returns {Promise<Object>} Deployment result
 */
export async function deployComposeStack(docker, composeContent, stackName) {
  try {
    const parsed = parseComposeFile(composeContent);
    const results = [];
    const createdContainers = [];

    // Deploy services in dependency order
    const servicesToDeploy = Object.keys(parsed.services);
    const deployedServices = new Set();

    async function deployService(serviceName) {
      if (deployedServices.has(serviceName)) {
        return;
      }

      const service = parsed.services[serviceName];

      // Deploy dependencies first
      for (const dep of service.depends_on || []) {
        if (parsed.services[dep] && !deployedServices.has(dep)) {
          await deployService(dep);
        }
      }

      // Deploy the service
      const containerName = `${stackName}_${serviceName}`;
      
      // Check if container already exists
      const existingContainers = await docker.listContainers({ all: true });
      const existing = existingContainers.find(c => 
        c.Names.some(n => n.includes(containerName))
      );

      if (existing) {
        logger.info(`Container ${containerName} already exists, skipping`);
        deployedServices.add(serviceName);
        results.push({ service: serviceName, status: 'exists', containerId: existing.Id });
        return;
      }

      // Build container config
      const containerConfig = {
        name: containerName,
        Image: service.image,
        Labels: {
          'com.docker.compose.project': stackName,
          'com.docker.compose.service': serviceName,
        },
      };

      if (service.command) {
        containerConfig.Cmd = service.command.split(' ');
      }

      if (service.entrypoint) {
        containerConfig.Entrypoint = service.entrypoint.split(' ');
      }

      if (service.environment && service.environment.length > 0) {
        containerConfig.Env = service.environment;
      }

      const hostConfig = {
        RestartPolicy: { Name: service.restart || 'no' },
      };

      if (service.ports && service.ports.length > 0) {
        hostConfig.PortBindings = {};
        service.ports.forEach(portStr => {
          if (portStr.includes(':')) {
            const [hostPort, containerPort] = portStr.split(':');
            const [port, protocol] = containerPort.split('/');
            hostConfig.PortBindings[`${port}/${protocol || 'tcp'}`] = [{ HostPort: hostPort }];
          }
        });
      }

      if (service.volumes && service.volumes.length > 0) {
        hostConfig.Binds = service.volumes;
      }

      containerConfig.HostConfig = hostConfig;

      // Create and start container
      const container = await docker.createContainer(containerConfig);
      await container.start();
      createdContainers.push(container.id);

      deployedServices.add(serviceName);
      results.push({ service: serviceName, status: 'created', containerId: container.id });

      logger.info(`Deployed service ${serviceName} as container ${containerName}`);
    }

    // Deploy all services
    for (const serviceName of servicesToDeploy) {
      await deployService(serviceName);
    }

    return {
      success: true,
      stackName,
      services: results,
      message: `Stack "${stackName}" deployed successfully`,
    };
  } catch (error) {
    logger.error('Failed to deploy compose stack', { error: error.message, stackName });
    throw error;
  }
}

/**
 * List all running stacks
 * @param {Docker} docker - Dockerode instance
 * @returns {Promise<Array>} List of stacks
 */
export async function listStacks(docker) {
  try {
    const containers = await docker.listContainers({ all: true });
    const stacks = {};

    containers.forEach(container => {
      const labels = container.Labels || {};
      const project = labels['com.docker.compose.project'];
      const service = labels['com.docker.compose.service'];

      if (project) {
        if (!stacks[project]) {
          stacks[project] = {
            name: project,
            services: [],
            containers: [],
          };
        }

        stacks[project].services.push(service || 'unknown');
        stacks[project].containers.push({
          id: container.Id,
          name: container.Names[0]?.replace(/^\//, '') || container.Id.substring(0, 12),
          state: container.State,
          image: container.Image,
        });
      }
    });

    return Object.values(stacks);
  } catch (error) {
    logger.error('Failed to list stacks', { error: error.message });
    throw error;
  }
}

/**
 * Remove a Docker Compose stack
 * @param {Docker} docker - Dockerode instance
 * @param {string} stackName - Name of the stack
 * @returns {Promise<Object>} Removal result
 */
export async function removeComposeStack(docker, stackName) {
  try {
    const containers = await docker.listContainers({ all: true });
    const stackContainers = containers.filter(c => {
      const labels = c.Labels || {};
      return labels['com.docker.compose.project'] === stackName;
    });

    const results = [];
    for (const containerInfo of stackContainers) {
      try {
        const container = docker.getContainer(containerInfo.Id);
        if (containerInfo.State === 'running') {
          await container.stop();
        }
        await container.remove({ force: true });
        results.push({ id: containerInfo.Id, success: true });
      } catch (error) {
        results.push({ id: containerInfo.Id, success: false, error: error.message });
      }
    }

    return {
      success: true,
      stackName,
      removed: results.length,
      results,
      message: `Stack "${stackName}" removed successfully`,
    };
  } catch (error) {
    logger.error('Failed to remove compose stack', { error: error.message, stackName });
    throw error;
  }
}

