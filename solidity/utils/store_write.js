const fs = require("fs");
const os = require("os");
const Web3 = require("web3");
const path = require("path");

const NODE_ADDRESS  = process.argv[2];
const STORE_ADDRESS = process.argv[3];
const PRIVATE_KEY   = process.argv[4];
const DATA_FOLDER   = process.argv[5];

const CFG_PROTECTED_LIQUIDITIES = {fileName: "protected_liquidities.csv", batchSize: 50};
const CFG_LOCKED_BALANCES       = {fileName: "locked_balances.csv"      , batchSize: 50};
const CFG_SYSTEM_BALANCES       = {fileName: "system_balances.csv"      , batchSize: 50};

const MIN_GAS_LIMIT = 100000;

const CFG_FILE_NAME = "migration.json";
const ARTIFACTS_DIR = path.resolve(__dirname, "../build");

const ROLE_SEEDER = Web3.utils.keccak256("ROLE_SEEDER");
const ROLE_OWNER  = Web3.utils.keccak256("ROLE_OWNER");

const readFileSync   = (fileName          ) => fs.readFileSync  (DATA_FOLDER + "/" + fileName,           {encoding: "utf8"});
const writeFileSync  = (fileName, fileData) => fs.writeFileSync (DATA_FOLDER + "/" + fileName, fileData, {encoding: "utf8"});
const appendFileSync = (fileName, fileData) => fs.appendFileSync(DATA_FOLDER + "/" + fileName, fileData, {encoding: "utf8"});

if (!fs.existsSync(DATA_FOLDER)) {
    fs.mkdirSync(DATA_FOLDER);
    writeFileSync(CFG_FILE_NAME, "{}");
}

function getConfig() {
    return JSON.parse(readFileSync(CFG_FILE_NAME));
}

function setConfig(record) {
    writeFileSync(CFG_FILE_NAME, JSON.stringify({...getConfig(), ...record}, null, 4));
}

async function scan(message) {
    process.stdout.write(message);
    return await new Promise((resolve, reject) => {
        process.stdin.resume();
        process.stdin.once("data", (data) => {
            process.stdin.pause();
            resolve(data.toString().trim());
        });
    });
}

async function getGasPrice(web3) {
    while (true) {
        const nodeGasPrice = await web3.eth.getGasPrice();
        const userGasPrice = await scan(`Enter gas-price or leave empty to use ${nodeGasPrice}: `);
        if (/^\d+$/.test(userGasPrice)) {
            return userGasPrice;
        }
        if (userGasPrice === "") {
            return nodeGasPrice;
        }
        console.log("Illegal gas-price");
    }
}

async function getTransactionReceipt(web3) {
    while (true) {
        const hash = await scan("Enter transaction-hash or leave empty to retry: ");
        if (/^0x([0-9A-Fa-f]{64})$/.test(hash)) {
            const receipt = await web3.eth.getTransactionReceipt(hash);
            if (receipt) {
                return receipt;
            }
            console.log("Invalid transaction-hash");
        }
        else if (hash) {
            console.log("Illegal transaction-hash");
        }
        else {
            return null;
        }
    }
}

async function send(web3, account, gasPrice, transaction, value = 0) {
    while (true) {
        try {
            const tx = {
                to: transaction._parent._address,
                data: transaction.encodeABI(),
                gas: Math.max(await transaction.estimateGas({from: account.address, value: value}), MIN_GAS_LIMIT),
                gasPrice: gasPrice || (await getGasPrice(web3)),
                chainId: await web3.eth.net.getId(),
                value: value
            };
            const signed = await web3.eth.accounts.signTransaction(tx, account.privateKey);
            const receipt = await web3.eth.sendSignedTransaction(signed.rawTransaction);
            return receipt;
        }
        catch (error) {
            console.log(error.message);
            const receipt = await getTransactionReceipt(web3);
            if (receipt) {
                return receipt;
            }
        }
    }
}

async function deploy(web3, account, gasPrice, contractId, contractName, contractArgs) {
    if (getConfig()[contractId] === undefined) {
        const abi = fs.readFileSync(path.join(ARTIFACTS_DIR, contractName + ".abi"), {encoding: "utf8"});
        const bin = fs.readFileSync(path.join(ARTIFACTS_DIR, contractName + ".bin"), {encoding: "utf8"});
        const contract = new web3.eth.Contract(JSON.parse(abi));
        const options = {data: "0x" + bin, arguments: contractArgs};
        const transaction = contract.deploy(options);
        const receipt = await send(web3, account, gasPrice, transaction);
        const args = transaction.encodeABI().slice(options.data.length);
        console.log(`${contractId} deployed at ${receipt.contractAddress}`);
        setConfig({
            [contractId]: {
                name: contractName,
                addr: receipt.contractAddress,
                args: args
            }
        });
    }
    return deployed(web3, contractName, getConfig()[contractId].addr);
}

function deployed(web3, contractName, contractAddr) {
    const abi = fs.readFileSync(path.join(ARTIFACTS_DIR, contractName + ".abi"), {encoding: "utf8"});
    return new web3.eth.Contract(JSON.parse(abi), contractAddr);
}

async function writeData(config, execute, func) {
    const lines = readFileSync(config.fileName).split(os.EOL).slice(1, -1);
    for (let i = 0; i < lines.length; i += config.batchSize) {
        const entries = lines.slice(i, i + config.batchSize).map(line => line.split(","));
        const values = [...Array(entries[0].length).keys()].map(n => entries.map(entry => entry[n]));
        await execute(func(...values));
    }
}

async function run() {
    const web3 = new Web3(NODE_ADDRESS);

    const gasPrice = await getGasPrice(web3);
    const account = web3.eth.accounts.privateKeyToAccount(PRIVATE_KEY);
    const web3Func = (func, ...args) => func(web3, account, gasPrice, ...args);

    let phase = 0;
    if (getConfig().phase === undefined) {
        setConfig({phase});
    }

    const execute = async (transaction, ...args) => {
        if (getConfig().phase === phase++) {
            await web3Func(send, transaction, ...args);
            console.log(`phase ${phase} executed`);
            setConfig({phase});
        }
    };

    const store = await web3Func(deploy, "liquidityProtectionStore", "LiquidityProtectionStore", []);
    await execute(store.methods.grantRole(ROLE_SEEDER, account.address));

    const nextProtectedLiquidityId = readFileSync("NextProtectedLiquidityId.txt");
    await execute(store.methods.seed_nextProtectedLiquidityId(nextProtectedLiquidityId));

    await writeData(CFG_PROTECTED_LIQUIDITIES, execute, store.methods.seed_protectedLiquidities);
    await writeData(CFG_LOCKED_BALANCES      , execute, store.methods.seed_lockedBalances      );
    await writeData(CFG_SYSTEM_BALANCES      , execute, store.methods.seed_systemBalances      );

    const owned = deployed(web3, "Owned", STORE_ADDRESS);
    await execute(store.methods.grantRole(ROLE_SEEDER, "0x".padEnd(42, "0")));
    await execute(store.methods.grantRole(ROLE_OWNER, await owned.methods.owner().call()));

    if (web3.currentProvider.disconnect) {
        web3.currentProvider.disconnect();
    }
}

run();