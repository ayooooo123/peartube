# peardock

## Overview

peardock is a decentralized, peer-to-peer application designed to streamline Docker container management using Hyperswarm. The application connects multiple peers over a distributed hash table (DHT) network and provides full control over Docker containers, including starting, stopping, removing, duplicating, viewing logs, deploying from templates, and monitoring real-time metrics. With its robust server key-based architecture, peardock ensures secure and persistent peer-to-peer communication.

The **server key** forms the foundation of the connection. It is automatically generated, saved, and reused unless explicitly refreshed, making it easy to maintain consistent access while allowing for manual key regeneration when needed.

In addition to a development environment, the client app can be run in **production mode** directly via Pear with the following command:

```bash
pear run pear://7to8bzrk53ab5ufwauqcw57s1kxmuykc9b8cdnjicaqcgoefa4wo
```

---

## Key Features

### Server-Side

- **Persistent Server Key**:
  - Generates a `SERVER_KEY` for each instance.
  - The key is saved to `.env` for consistent re-use.
  - Supports manual key regeneration by deleting `.env`.

- **Real-Time Docker Management**:
  - List all containers across peers with statuses.
  - Start, stop, restart, and remove containers remotely.

- **Dynamic Terminal Sessions**:
  - Open and manage multiple terminals for running containers.
  - Real-time shell sessions streamed to connected peers.

- **Docker CLI Terminal**:
  - Access a Docker CLI terminal to run Docker commands on the remote peer.

- **Container Duplication**:
  - Clone containers with custom configurations for CPUs, memory, network mode, and hostname.

- **Template Deployment**:
  - Deploy containers using templates fetched from a remote repository.
  - Customize deployment parameters such as ports, volumes, and environment variables.

- **Container Logs**:
  - View real-time and historical logs of containers.

- **Live Statistics Streaming**:
  - Broadcast CPU, memory, and network stats in real-time to connected peers.

### Client-Side

- **Peer-to-Peer Networking**:
  - Connects to servers using unique server keys via Hyperswarm.
  - Fully decentralized; no central server is required.

- **Interactive User Interface**:
  - Modern, responsive UI built with **Bootstrap**.
  - Integrated terminal viewer powered by **Xterm.js**.
  - Real-time container stats displayed for each container.
  - View container logs directly from the UI.
  - Deploy containers using templates with a user-friendly wizard.

- **Production Deployment**:
  - Ready-to-use client app available via Pear runtime:
    ```bash
    pear run pear://7to8bzrk53ab5ufwauqcw57s1kxmuykcgoefa4wo
    ```

---

## How It Works

### Server Key Architecture

The server is initialized with a `SERVER_KEY` that uniquely identifies the network. This key is essential for peers to connect and interact with the server.

- **Key Generation**:
  - On the first run, the server checks for an existing `SERVER_KEY` in the `.env` file. If absent, a new key is generated:
    ```javascript
    function generateNewKey() {
      const newKey = crypto.randomBytes(32);
      fs.appendFileSync('.env', `SERVER_KEY=${newKey.toString('hex')}\n`, { flag: 'a' });
      return newKey;
    }
    ```
  - The key is saved to `.env` for persistence.

- **Key Usage**:
  - The server uses the key to generate a topic buffer for Hyperswarm:
    ```javascript
    const topic = Buffer.from(keyHex, 'hex');
    swarm.join(topic, { server: true, client: false });
    ```

- **Key Refresh**:
  - To regenerate the key, delete the `.env` file and restart the server.

### Peer Connections

Peers connect to the server using the unique topic derived from the `SERVER_KEY`. The Hyperswarm network ensures secure, low-latency connections.

- **Connecting**:
  - Each client app connects to the server by joining the topic buffer:
    ```javascript
    const topicBuffer = b4a.from(topicHex, 'hex');
    swarm.join(topicBuffer, { client: true, server: true });
    ```

- **Communication**:
  - Commands (e.g., `listContainers`, `startContainer`) are sent as JSON over the connection.
  - Responses and real-time updates are broadcast back to peers.

### Docker Integration

The server interacts with Docker using **Dockerode**:

- **List Containers**:
  ```javascript
  const containers = await docker.listContainers({ all: true });
  ```
- **Start a Container**:
  ```javascript
  await docker.getContainer(containerId).start();
  ```
- **Stream Statistics**:
  ```javascript
  container.stats({ stream: true }, (err, stream) => {
    stream.on('data', (data) => {
      const stats = JSON.parse(data.toString());
      broadcastToPeers({ type: 'stats', data: stats });
    });
  });
  ```
- **Docker CLI Commands**:
  - Execute Docker commands received from the client within controlled parameters to ensure security.

---

## Installation

### Prerequisites

1. **Docker**:
   - Install Docker and ensure it is running.
   - For Linux, add your user to the Docker group:
     ```bash
     sudo usermod -aG docker $USER
     ```
     Log out and back in for changes to take effect.

2. **Node.js**:
   - Install Node.js v16 or higher:
     ```bash
     sudo apt install nodejs npm
     ```

3. **Pear**:
   - Install the Pear runtime for running the client and server:
     ```bash
     npm install -g pear
     ```

---

### Server Setup

1. **Clone the Repository**:
   ```bash
   git clone https://git.ssh.surf/snxraven/peardock.git
   cd peardock
   ```

2. **Change to Server Directory**:
   ```bash
   cd server
   ```

3. **Install Dependencies**:
   ```bash
   npm install hyperswarm dockerode hypercore-crypto stream dotenv
   ```

4. **Run the Server**:
   ```bash
   node server.js
   ```

---

### Client Setup

1. **For Development**, run:
   ```bash
   pear run --dev .
   ```

2. **For Production**, use the pre-deployed Pear app:
   ```bash
   pear run pear://7to8bzrk53ab5ufwauqcw57s1kxmuykc9b8cdnjicaqcgoefa4wo
   ```

---

## Usage

### Connecting to a Server

1. Launch the client app.
2. Enter the server's `SERVER_KEY` in the connection form to join its topic.

### Managing Containers

- **Listing Containers**:
  - View all containers (running and stopped) with their statuses.

- **Starting/Stopping/Restarting Containers**:
  - Use the action buttons (play, stop, restart icons) in the container list.

- **Removing Containers**:
  - Click the trash icon to delete a container.

- **Viewing Container Logs**:
  - Click the logs icon to view real-time and historical logs of a container.

- **Duplicating Containers**:
  - Click the clone icon and customize the duplication form.

### Terminal Access

- **Container Terminal**:
  - Open terminals for running containers by clicking the terminal icon.
  - Switch between sessions using the tray at the bottom.

- **Docker CLI Terminal**:
  - Access a Docker CLI terminal to execute Docker commands on the remote peer.
  - Click the Docker terminal icon in the connection list.

### Template Deployment

- **Deploying from Templates**:
  - Open the template deployment modal by clicking the deploy template icon.
  - Search and select templates from the list.
  - Customize deployment parameters such as container name, image, ports, volumes, and environment variables.
  - Deploy the container with the specified settings.

---

## Screenshots

### Welcome Screen

![Welcome Screen](https://git.ssh.surf/snxraven/peardock/raw/branch/main/screenshots/screenshot-0.png)

*The initial welcome screen guiding users to add a connection.*

---

### Container List

![Container List](https://git.ssh.surf/snxraven/peardock/raw/branch/main/screenshots/screenshot-1.png)

*Displaying all Docker containers with real-time stats and action buttons.*

---

### Template Deployments

![Template Deployments](https://git.ssh.surf/snxraven/peardock/raw/branch/main/screenshots/screenshot-2.png)

*Browsing and selecting templates for deployment from a remote repository.*

---

### Final Deploy Modal

![Final Deploy Modal](https://git.ssh.surf/snxraven/peardock/raw/branch/main/screenshots/screenshot-3.png)

*Customizing deployment parameters before launching a new container.*

---

### Duplicate Container Form

![Duplicate Container Form](https://git.ssh.surf/snxraven/peardock/raw/branch/main/screenshots/screenshot-4.png)

*Duplicating an existing container with options to modify configurations.*

---

### Container Logs

![Container Logs](https://git.ssh.surf/snxraven/peardock/raw/branch/main/screenshots/screenshot-5.png)

*Viewing real-time logs of a container directly from the UI.*

---

## Customization

### UI Customization

- Modify the layout and styling in `index.html` and the embedded CSS.

### Terminal Behavior

- Adjust terminal settings in `libs/terminal.js`:
  ```javascript
  const xterm = new Terminal({
    cursorBlink: true,
    theme: { background: '#1a1a1a', foreground: '#ffffff' },
  });
  ```

### Docker Commands

- Add new commands in `server/server.js` under the `switch` statement for additional Docker functionalities:
  ```javascript
  switch (parsedData.command) {
    case 'newCommand':
      // Implement your command logic here
      break;
    // Existing cases...
  }
  ```

---

## Security

- The `SERVER_KEY` is sensitive and should be stored securely.
- Refresh the key periodically to enhance security, especially in untrusted environments.
- peardock uses encrypted peer-to-peer connections, but it's recommended to run it within secure networks.
- Limit access to the server by controlling who has the `SERVER_KEY`.

---

## Troubleshooting

### Common Issues

1. **Unable to Connect**:
   - Verify the `SERVER_KEY` matches on both server and client.
   - Ensure the server is running and accessible.
   - Check network configurations and firewall settings.

2. **Docker Errors**:
   - Ensure Docker is running and properly configured.
   - Check permissions to manage Docker.
   - Verify that the user running the server has access to the Docker daemon.

3. **Terminal Issues**:
   - Verify the container has a valid shell (e.g., `/bin/bash`).
   - Ensure that the container is running before opening a terminal.
   - Check for network latency that might affect terminal responsiveness.

4. **Template Deployment Failures**:
   - Ensure the Docker image specified in the template is valid and accessible.
   - Check network connectivity if pulling images from remote repositories.
   - Validate all required parameters in the deployment form.

---

## Contributing

Contributions are welcome! Fork the repository, make your changes, and submit a pull request.

1. **Fork the Repository**:
   - Click the "Fork" button at the top of the repository page.

2. **Clone Your Fork**:
   ```bash
   git clone https://github.com/your-username/peardock.git
   ```

3. **Create a Branch for Your Feature**:
   ```bash
   git checkout -b feature/your-feature-name
   ```

4. **Make Changes and Commit**:
   ```bash
   git add .
   git commit -m "Add your feature"
   ```

5. **Push to Your Fork**:
   ```bash
   git push origin feature/your-feature-name
   ```

6. **Submit a Pull Request**:
   - Go to your fork on GitHub and click the "New pull request" button.

---

## Acknowledgments

- **Portainer**: For inspiring the creation of a powerful Docker management tool.
- **Hyperswarm**: Providing the peer-to-peer networking backbone.
- **Dockerode**: Facilitating Docker API interactions in Node.js.

---

## Contact

For questions, issues, or suggestions, please open an issue on the [GitHub repository](https://git.ssh.surf/snxraven/peardock).