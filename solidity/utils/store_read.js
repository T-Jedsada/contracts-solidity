const fs = require("fs");
const os = require("os");
const path = require("path");
const Web3 = require("web3");

const {
    ADD_PROTECTED_LIQUIDITIES  ,
    ADD_LOCKED_BALANCES        ,
    ADD_SYSTEM_BALANCES        ,
    NEXT_PROTECTED_LIQUIDITY_ID,
} = require("./file_names.js");

const DATA_FOLDER   = process.argv[2];
const NODE_ADDRESS  = process.argv[3];
const STORE_ADDRESS = process.argv[4];
const STORAGE_INDEX = process.argv[5];
const SCRIPT_INFO   = process.argv[6]; // either 'contract deployment block number' or 'system balances file path'

const BATCH_SIZE = 100;

const ARTIFACTS_DIR = path.resolve(__dirname, "../build");

const readFileSync   = (fileName          ) => fs.readFileSync  (path.resolve(DATA_FOLDER, fileName),           {encoding: "utf8"});
const writeFileSync  = (fileName, fileData) => fs.writeFileSync (path.resolve(DATA_FOLDER, fileName), fileData, {encoding: "utf8"});
const appendFileSync = (fileName, fileData) => fs.appendFileSync(path.resolve(DATA_FOLDER, fileName), fileData, {encoding: "utf8"});

if (!fs.existsSync(DATA_FOLDER)) {
    fs.mkdirSync(DATA_FOLDER);
}

function printRow(fileName, ...cellValues) {
    const row = cellValues.map(value => String(value).trim()).join(",") + os.EOL;
    appendFileSync(fileName, row);
    process.stdout.write(row);
}

async function rpc(func) {
    while (true) {
        try {
            return await func.call();
        }
        catch (error) {
            console.log(error.message);
            if (error.message.startsWith("Invalid JSON RPC response") || error.message.endsWith("project ID request rate exceeded")) {
                await new Promise(r => setTimeout(r, 10000));
            }
            else {
                throw error;
            }
        }
    }
}

async function getPastEvents(contract, eventName, fromBlock, toBlock, filter) {
    if (fromBlock <= toBlock) {
        try {
            return await contract.getPastEvents(eventName, {fromBlock: fromBlock, toBlock: toBlock, filter: filter});
        }
        catch (error) {
            const midBlock = (fromBlock + toBlock) >> 1;
            const arr1 = await getPastEvents(contract, eventName, fromBlock, midBlock);
            const arr2 = await getPastEvents(contract, eventName, midBlock + 1, toBlock);
            return [...arr1, ...arr2];
        }
    }
    return [];
}

async function getPoolInfo(web3, store) {
    const fromBlock = Number(SCRIPT_INFO);
    if (fromBlock >= 0 && fromBlock % 1 == 0) {
        const events     = await getPastEvents(store, "SystemBalanceUpdated", fromBlock, await web3.eth.getBlockNumber());
        const tokens     = [...new Set(events.map(event => event.returnValues._token))];
        const owners     = await Promise.all(tokens.map(token => rpc(deployed(web3, "DSToken", token).methods.owner())));
        const converters = owners.map(owner => deployed(web3, "ConverterBase", owner));
        const reserve0s  = await Promise.all(converters.map(converter => rpc(converter.methods.connectorTokens(0))));
        const reserve1s  = await Promise.all(converters.map(converter => rpc(converter.methods.connectorTokens(1))));
        return [tokens, reserve0s, reserve1s];
    }
    else {
        const lines     = fs.readFileSync(path.resolve(SCRIPT_INFO, ADD_SYSTEM_BALANCES), {encoding: "utf8"}).split(os.EOL).slice(1, -1);
        const tokens    = lines.map(line => line.split(",")[0]);
        const reserve0s = lines.map(line => line.split(",")[3]);
        const reserve1s = lines.map(line => line.split(",")[4]);
        return [tokens, reserve0s, reserve1s];
    }
}

async function readProtectedLiquidities(web3, store) {
    writeFileSync(ADD_PROTECTED_LIQUIDITIES, "");

    printRow(
        ADD_PROTECTED_LIQUIDITIES,
        "id           ",
        "provider     ",
        "poolToken    ",
        "reserveToken ",
        "poolAmount   ",
        "reserveAmount",
        "reserveRateN ",
        "reserveRated ",
        "timestamp    ",
    );

    const count = Web3.utils.toBN(await web3.eth.getStorageAt(STORE_ADDRESS, STORAGE_INDEX)).toNumber();
    writeFileSync(NEXT_PROTECTED_LIQUIDITY_ID, String(count));

    for (let i = 0; i < count; i += BATCH_SIZE) {
        const ids = [...Array(Math.min(count, BATCH_SIZE + i) - i).keys()].map(n => n + i);
        const pls = await Promise.all(ids.map(id => rpc(store.methods.protectedLiquidity(id))));
        for (let j = 0; j < ids.length; j++) {
            const values = Object.keys(pls[j]).map(key => pls[j][key]);
            if (values.some(value => Web3.utils.toBN(value).gtn(0))) {
                printRow(ADD_PROTECTED_LIQUIDITIES, ids[j], ...values);
            }
        }
    }
}

async function readLockedBalances(web3, store) {
    writeFileSync(ADD_LOCKED_BALANCES, "");

    printRow(
        ADD_LOCKED_BALANCES,
        "provider      ",
        "amount        ",
        "expirationTime",
    );

    const providers = [...new Set(readFileSync(ADD_PROTECTED_LIQUIDITIES).split(os.EOL).slice(1, -1).map(line => line.split(",")[1]))];
    for (let i = 0; i < providers.length; i += BATCH_SIZE) {
        const indexes = [...Array(Math.min(providers.length, BATCH_SIZE + i) - i).keys()].map(n => n + i);
        const counts = await Promise.all(indexes.map(index => rpc(store.methods.lockedBalanceCount(providers[index]))));
        for (let j = 0; j < indexes.length; j++) {
            if (counts[j] > 0) {
                const lbs = await rpc(store.methods.lockedBalanceRange(providers[indexes[j]], 0, counts[j]));
                for (let i = 0; i < counts[j]; i++) {
                    printRow(ADD_LOCKED_BALANCES, providers[indexes[j]], ...[...Array(2).keys()].map(n => lbs[n][i]));
                }
            }
        }
    }
}

async function readSystemBalances(web3, store) {
    writeFileSync(ADD_SYSTEM_BALANCES, "");

    printRow(
        ADD_SYSTEM_BALANCES,
        "token         ",
        "systemBalance ",
        "poolAmount    ",
        "reserve0      ",
        "reserve1      ",
        "reserve0Amount",
        "reserve1Amount",
    );

    const [tokens, reserve0s, reserve1s] = await getPoolInfo(web3, store);

    const systemBalances  = await Promise.all(tokens.map(token => rpc(store.methods.systemBalance(token))));
    const poolAmounts     = await Promise.all(tokens.map(token => rpc(store.methods.totalProtectedPoolAmount(token))));
    const reserve0Amounts = await Promise.all(tokens.map((token, i) => rpc(store.methods.totalProtectedReserveAmount(token, reserve0s[i]))));
    const reserve1Amounts = await Promise.all(tokens.map((token, i) => rpc(store.methods.totalProtectedReserveAmount(token, reserve1s[i]))));

    for (let i = 0; i < tokens.length; i++) {
        printRow(
            ADD_SYSTEM_BALANCES,
            tokens         [i],
            systemBalances [i],
            poolAmounts    [i],
            reserve0s      [i],
            reserve1s      [i],
            reserve0Amounts[i],
            reserve1Amounts[i],
        );
    }
}

function deployed(web3, contractName, contractAddr) {
    const abi = fs.readFileSync(path.join(ARTIFACTS_DIR, contractName + ".abi"), {encoding: "utf8"});
    return new web3.eth.Contract(JSON.parse(abi), contractAddr);
}

async function run() {
    const web3 = new Web3(NODE_ADDRESS);
    const store = deployed(web3, "LiquidityProtectionStore", STORE_ADDRESS);
    await readProtectedLiquidities(web3, store);
    await readLockedBalances(web3, store);
    await readSystemBalances(web3, store);
    if (web3.currentProvider.disconnect) {
        web3.currentProvider.disconnect();
    }
}

run();