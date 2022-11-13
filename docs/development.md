# Setting up Development Environment

## Install Node.js

Install Node.js by your favorite method, or use Node Version Manager by following directions at https://github.com/creationix/nvm

```bash
nvm install v4
```

## Fork and Download Repositories

To develop meowcoincore-node:

```bash
cd ~
git clone git@github.com:<yourusername>/meowcoincore-node.git
git clone git@github.com:<yourusername>/meowcoincore-lib.git
```

To develop meowcoin or to compile from source:

```bash
git clone git@github.com:<yourusername>/meowcoin.git
git fetch origin <branchname>:<branchname>
git checkout <branchname>
```
**Note**: See meowcoin documentation for building meowcoin on your platform.


## Install Development Dependencies

For Ubuntu:
```bash
sudo apt-get install libzmq3-dev
sudo apt-get install build-essential
```
**Note**: Make sure that libzmq-dev is not installed, it should be removed when installing libzmq3-dev.


For Mac OS X:
```bash
brew install zeromq
```

## Install and Symlink

```bash
cd meowcoincore-lib
npm install
cd ../meowcoincore-node
npm install
```
**Note**: If you get a message about not being able to download meowcoin distribution, you'll need to compile meowcoind from source, and setup your configuration to use that version.


We now will setup symlinks in `meowcoincore-node` *(repeat this for any other modules you're planning on developing)*:
```bash
cd node_modules
rm -rf meowcoincore-lib
ln -s ~/meowcoincore-lib
rm -rf meowcoind-rpc
ln -s ~/meowcoind-rpc
```

And if you're compiling or developing meowcoin:
```bash
cd ../bin
ln -sf ~/meowcoin/src/meowcoind
```

## Run Tests

If you do not already have mocha installed:
```bash
npm install mocha -g
```

To run all test suites:
```bash
cd meowcoincore-node
npm run regtest
npm run test
```

To run a specific unit test in watch mode:
```bash
mocha -w -R spec test/services/meowcoind.unit.js
```

To run a specific regtest:
```bash
mocha -R spec regtest/meowcoind.js
```

## Running a Development Node

To test running the node, you can setup a configuration that will specify development versions of all of the services:

```bash
cd ~
mkdir devnode
cd devnode
mkdir node_modules
touch meowcoincore-node.json
touch package.json
```

Edit `meowcoincore-node.json` with something similar to:
```json
{
  "network": "livenet",
  "port": 3001,
  "services": [
    "meowcoind",
    "web",
    "insight-api",
    "insight-ui",
    "<additional_service>"
  ],
  "servicesConfig": {
    "meowcoind": {
      "spawn": {
        "datadir": "/home/<youruser>/.meowcoind",
        "exec": "/home/<youruser>/meowcoin/src/meowcoind"
      }
    }
  }
}
```

**Note**: To install services [insight-api](https://github.com/rvnminers-A-and-N/insight-api) and [insight-ui](https://github.com/rvnminers-A-and-N/insight-ui) you'll need to clone the repositories locally.

Setup symlinks for all of the services and dependencies:

```bash
cd node_modules
ln -s ~/meowcoincore-lib
ln -s ~/meowcoincore-node
ln -s ~/insight-api
ln -s ~/insight-ui
```

Make sure that the `<datadir>/meowcoin.conf` has the necessary settings, for example:
```
server=1
whitelist=127.0.0.1
txindex=1
addressindex=1
timestampindex=1
spentindex=1
zmqpubrawtx=tcp://127.0.0.1:28332
zmqpubhashblock=tcp://127.0.0.1:28332
rpcallowip=127.0.0.1
rpcuser=meowcoin
rpcpassword=local321
```

From within the `devnode` directory with the configuration file, start the node:
```bash
../meowcoincore-node/bin/meowcoincore-node start
```
