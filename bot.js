// -- HANDLE INITIAL SETUP -- //
require('./helpers/server')
require("dotenv").config();

const ethers = require("ethers")
const config = require('./config.json')
const { getTokenAndContract, getPairContract, getReserves, calculatePrice, simulate } = require('./helpers/helpers')
const { provider, uFactory, uRouter, sFactory, sRouter, arbitrage } = require('./helpers/initialization')

// -- .ENV VALUES HERE -- //
const arbFor = process.env.ARB_FOR // This is the address of token we are attempting to arbitrage (WETH)
const arbAgainst = process.env.ARB_AGAINST // SHIB
const units = process.env.UNITS // Used for price display/reporting
const difference = process.env.PRICE_DIFFERENCE
const gasLimit = process.env.GAS_LIMIT
const gasPrice = process.env.GAS_PRICE // Estimated Gas: 0.008453220000006144 ETH + ~10%

let uPair, sPair, amount
let isExecuting = false

const main = async () => {
  const { token0Contract, token1Contract, token0, token1 } = await getTokenAndContract(arbFor, arbAgainst, provider)
  uPair = await getPairContract(uFactory, token0.address, token1.address, provider)
  sPair = await getPairContract(sFactory, token0.address, token1.address, provider)

  console.log(`uPair Address: ${await uPair.getAddress()}`)
  console.log(`sPair Address: ${await sPair.getAddress()}\n`)

  uPair.on('Swap', async () => {
    if (!isExecuting) {
      isExecuting = true

      const priceDifference = await checkPrice('Uniswap', token0, token1)
      const routerPath = await determineDirection(priceDifference)

      if (!routerPath) {
        console.log(`No Arbitrage Currently Available\n`)
        console.log(`-----------------------------------------\n`)
        isExecuting = false
        return
      }

      const isProfitable = await determineProfitability(routerPath, token0Contract, token0, token1)

      if (!isProfitable) {
        console.log(`No Arbitrage Currently Available\n`)
        console.log(`-----------------------------------------\n`)
        isExecuting = false
        return
      }

      const receipt = await executeTrade(routerPath, token0Contract, token1Contract)

      isExecuting = false
    }
  })

  sPair.on('Swap', async () => {
    if (!isExecuting) {
      isExecuting = true

      const priceDifference = await checkPrice('Sushiswap', token0, token1)
      const routerPath = await determineDirection(priceDifference)

      if (!routerPath) {
        console.log(`No Arbitrage Currently Available\n`)
        console.log(`-----------------------------------------\n`)
        isExecuting = false
        return
      }

      const isProfitable = await determineProfitability(routerPath, token0Contract, token0, token1)

      if (!isProfitable) {
        console.log(`No Arbitrage Currently Available\n`)
        console.log(`-----------------------------------------\n`)
        isExecuting = false
        return
      }

      const receipt = await executeTrade(routerPath, token0Contract, token1Contract)

      isExecuting = false
    }
  })

  console.log("Waiting for swap event...")
}

const checkPrice = async (_exchange, _token0, _token1) => {
  isExecuting = true

  console.log(`Swap Initiated on ${_exchange}, Checking Price...\n`)

  const currentBlock = await provider.getBlockNumber()

  const uPrice = await calculatePrice(uPair)
  const sPrice = await calculatePrice(sPair)

  const uFPrice = Number(uPrice).toFixed(units)
  const sFPrice = Number(sPrice).toFixed(units)
  const priceDifference = (((uFPrice - sFPrice) / sFPrice) * 100).toFixed(2)

  console.log(`Current Block: ${currentBlock}`)
  console.log(`-----------------------------------------`)
  console.log(`UNISWAP   | ${_token1.symbol}/${_token0.symbol}\t | ${uFPrice}`)
  console.log(`SUSHISWAP | ${_token1.symbol}/${_token0.symbol}\t | ${sFPrice}\n`)
  console.log(`Percentage Difference: ${priceDifference}%\n`)

  return priceDifference
}

const determineDirection = async (_priceDifference) => {
  console.log(`Determining Direction...\n`)
  let uPairReserve = (await getReserves(uPair))
  let uPairPrice = Number((uPairReserve[0]) / uPairReserve[1])
  let uPairConstant = Number(uPairReserve[0] * uPairReserve[1])

  let sPairReserve = (await getReserves(sPair))
  let sPairPrice = Number(sPairReserve[0] / sPairReserve[1])
  let sPairConstant = Number(sPairReserve[0] * sPairReserve[1])

  let KRatio = Math.sqrt(Number(uPairConstant/sPairConstant))
  let uKModifier = KRatio / (1 + KRatio)
  let sKModifier = 1 - uKModifier

  let totalReserves = [Number(uPairReserve[0] + sPairReserve[0]), Number(uPairReserve[1] + sPairReserve[1])]
  let priceSynced = (Number(totalReserves[0]) / Number(totalReserves[1]))

  console.log()

  console.log('uPair Reserves: ', uPairReserve)
  console.log('\tPrice: ', uPairPrice)
  console.log('\nsPair Reserves: ', sPairReserve)
  console.log('\tPrice: ', sPairPrice)
  console.log("\n")
  console.log('Combined Reserves: ', totalReserves)
  console.log("Synced Price: ", priceSynced)

  console.log("K Modifiers: ", uKModifier, sKModifier)

  /*
  uPairReserve = [10, 2]
  sPairReserve = [24, 4]

  uPairConstant = uPairReserve[0] * uPairReserve[1]
  sPairConstant = (sPairReserve[0] * sPairReserve[1])

  uPairPrice = (uPairReserve[0] / uPairReserve[1])
  sPairPrice = (sPairReserve[0] / sPairReserve[1])

  priceSynced = ((uPairReserve[0] + sPairReserve[0]) / (uPairReserve[1] + sPairReserve[1]))
  */
  
  let finalBforPriceOnU = Number(Math.sqrt(uPairConstant/priceSynced))
  let receivedBfromU = Number(uPairReserve[1]) - Number(finalBforPriceOnU)
  let spentAonU = Number(uPairConstant/finalBforPriceOnU) - Number(uPairReserve[0])
  let receivedAfromS = Number(sPairReserve[0]) - Number((sPairConstant / (Number(sPairReserve[1]) + Number(receivedBfromU))))

  let finalBforPriceOnS = Number(Math.sqrt(sPairConstant/priceSynced))
  let receivedBfromS = Number(sPairReserve[1]) - Number(finalBforPriceOnS)
  let spentAonS = Number(sPairConstant/finalBforPriceOnS) - Number(sPairReserve[0])
  let receivedAfromU = Number(uPairReserve[0]) - Number((uPairConstant / (Number(uPairReserve[1]) + Number(receivedBfromS))))

  console.log("\n\n uPairReserve", uPairReserve, "\n",
            "sPairReserve", sPairReserve, "\n",
            "uPairConstant", uPairConstant, "\n",
            "sPairConstant", sPairConstant, "\n",
            "uPairPrice", uPairPrice, "\n",
            "sPairPrice", sPairPrice, "\n",
            "priceSynced", priceSynced, "\n",
            "finalBforPriceOnU", finalBforPriceOnU, "\n",
            "receivedBfromU", receivedBfromU, "\n",
            "spentAonU", spentAonU, "\n",
            "receivedAfromS", receivedAfromS, "\n\n")

  console.log("\n\n sPairReserve", sPairReserve, "\n",
            "uPairReserve", uPairReserve, "\n",
            "sPairConstant", sPairConstant, "\n",
            "uPairConstant", uPairConstant, "\n",
            "sPairPrice", sPairPrice, "\n",
            "uPairPrice", uPairPrice, "\n",
            "priceSynced", priceSynced, "\n",
            "finalBforPriceOnS", finalBforPriceOnS, "\n",
            "receivedBfromS", receivedBfromS, "\n",
            "spentAonS", spentAonS, "\n",
            "receivedAfromU", receivedAfromU, "\n\n")

  let profitBeforeFees

  if ((_priceDifference >= difference) || (_priceDifference <= -(difference))) {

    if (receivedBfromS > 0) {
    profitBeforeFees = Number(receivedAfromS - spentAonU)

    console.log(`Potential Arbitrage Direction:\n`)
    console.log(`Buy\t -->\t Uniswap`)
    console.log(`Sell\t -->\t Sushiswap\n`)
    console.log('profitBeforeFees: ', profitBeforeFees, "\n")
    return [uRouter, sRouter]

  } else if (receivedBfromU > 0) {
    profitBeforeFees = Number(receivedAfromU - spentAonS)

    console.log(`Potential Arbitrage Direction:\n`)
    console.log(`Buy\t -->\t Sushiswap`)
    console.log(`Sell\t -->\t Uniswap\n`)
    console.log('profitBeforeFees: ', profitBeforeFees, "\n")
    return [sRouter, uRouter]

  } else {
    console.log("oh no....")
  }

  } else {
    console.log("Price difference not high enough...")
    return null
  }
}

const determineProfitability = async (_routerPath, _token0Contract, _token0, _token1) => {
  console.log(`Determining Profitability...\n`)

  // This is where you can customize your conditions on whether a profitable trade is possible...

  let exchangeToBuy, exchangeToSell

  if (await _routerPath[0].getAddress() === await uRouter.getAddress()) {
    exchangeToBuy = "Uniswap"
    exchangeToSell = "Sushiswap"
  } else {
    exchangeToBuy = "Sushiswap"
    exchangeToSell = "Uniswap"
  }

  /**
   * The helper file has quite a few functions that come in handy
   * for performing specifc tasks. Below we call the getReserves()
   * function in the helper to get the reserves of a pair.
   */

  const uReserves = await getReserves(uPair)
  const sReserves = await getReserves(sPair)

  let uPairReserve = uReserves
  let uPairPrice = Number(uPairReserve[0] / uPairReserve[1])
  let uPairConstant = Number(uPairReserve[0] * uPairReserve[1])

  let sPairReserve = sReserves
  let sPairPrice = Number(sPairReserve[0] / sPairReserve[1])
  let sPairConstant = Number(sPairReserve[0] * sPairReserve[1])

  let KRatio = Math.sqrt(Number(uPairConstant/sPairConstant))
  let uKModifier = KRatio / (1 + KRatio)
  let sKModifier = 1 - uKModifier

  let totalReserves = [Number(uPairReserve[0] + sPairReserve[0]), Number(uPairReserve[1] + sPairReserve[1])]
  let priceSynced = (Number(totalReserves[0]) / Number(totalReserves[1]))
  
  let finalBforPriceOnU = Number(Math.sqrt(uPairConstant/priceSynced))
  let receivedBfromU = Number(uPairReserve[1]) - Number(finalBforPriceOnU)
  let spentAonU = Number(uPairConstant/finalBforPriceOnU) - Number(uPairReserve[0])
  let receivedAfromS = Number(sPairReserve[0]) - Number((sPairConstant / (Number(sPairReserve[1]) + Number(receivedBfromU))))

  let finalBforPriceOnS = Number(Math.sqrt(sPairConstant/priceSynced))
  let receivedBfromS = Number(sPairReserve[1]) - Number(finalBforPriceOnS)
  let spentAonS = Number(sPairConstant/finalBforPriceOnS) - Number(sPairReserve[0])
  let receivedAfromU = Number(uPairReserve[0]) - Number((uPairConstant / (Number(uPairReserve[1]) + Number(receivedBfromS))))

  let minAmount

  if (receivedBfromU > 0) {
    minAmount = spentAonU
  } else {
    minAmount = spentAonS
  }

  console.log("minAmount", minAmount, "\n\n",)

  try {

    /**
     * See getAmountsIn & getAmountsOut:
     * - https://docs.uniswap.org/contracts/v2/reference/smart-contracts/library#getamountsin
     * - https://docs.uniswap.org/contracts/v2/reference/smart-contracts/library#getamountsout
     */

    console.log("BigInt(minAmount)", BigInt(minAmount))
    

    // This returns the amount of WETH needed to swap for X amount of SHIB
    const estimate = await _routerPath[0].getAmountsIn(BigInt(minAmount), [_token0.address, _token1.address])

    // This returns the amount of WETH for swapping X amount of SHIB
    const result = await _routerPath[1].getAmountsOut(estimate[1], [_token1.address, _token0.address])

    console.log("estimate", estimate)
    console.log("result", result)

    console.log(`Estimated amount of WETH needed to buy enough Shib on ${exchangeToBuy}\t\t| ${ethers.formatUnits(estimate[0], 'ether')}`)
    console.log(`Estimated amount of WETH returned after swapping SHIB on ${exchangeToSell}\t| ${ethers.formatUnits(result[1], 'ether')}\n`)

    const { amountIn, amountOut } = await simulate(estimate[0], _routerPath, _token0, _token1)
    const amountDifference = amountOut - amountIn
    const estimatedGasCost = gasLimit * gasPrice

    console.log("amountIn", amountIn, "amountOut", amountOut)

    // Fetch account
    const account = new ethers.Wallet(process.env.PRIVATE_KEY, provider)

    const ethBalanceBefore = ethers.formatUnits(await provider.getBalance(account.address), 'ether')
    const ethBalanceAfter = ethBalanceBefore - estimatedGasCost

    const wethBalanceBefore = Number(ethers.formatUnits(await _token0Contract.balanceOf(account.address), 'ether'))
    const wethBalanceAfter = amountDifference + wethBalanceBefore
    const wethBalanceDifference = wethBalanceAfter - wethBalanceBefore

    const data = {
      'ETH Balance Before': ethBalanceBefore,
      'ETH Balance After': ethBalanceAfter,
      'ETH Spent (gas)': estimatedGasCost,
      '-': {},
      'WETH Balance BEFORE': wethBalanceBefore,
      'WETH Balance AFTER': wethBalanceAfter,
      'WETH Gained/Lost': wethBalanceDifference,
      '-': {},
      'Total Gained/Lost': wethBalanceDifference - estimatedGasCost
    }

    console.table(data)
    console.log()

    if (amountOut < amountIn) {
      return false
    }

    amount = ethers.parseUnits(amountIn, 'ether')
    return true

  } catch (error) {
    console.log(error)
    console.log(`\nError occured while trying to determine profitability...\n`)
    console.log(`This can typically happen because of liquidity issues, see README for more information.\n`)
    return false
  }
}

const executeTrade = async (_routerPath, _token0Contract, _token1Contract) => {
  console.log(`Attempting Arbitrage...\n`)

  let startOnUniswap

  if (await _routerPath[0].getAddress() == await uRouter.getAddress()) {
    startOnUniswap = true
  } else {
    startOnUniswap = false
  }

  // Create Signer
  const account = new ethers.Wallet(process.env.PRIVATE_KEY, provider)

  // Fetch token balances before
  const tokenBalanceBefore = await _token0Contract.balanceOf(account.address)
  const ethBalanceBefore = await provider.getBalance(account.address)

  if (config.PROJECT_SETTINGS.isDeployed) {
    const transaction = await arbitrage.connect(account).executeTrade(
      startOnUniswap,
      await _token0Contract.getAddress(),
      await _token1Contract.getAddress(),
      amount,
      { gasLimit: process.env.GAS_LIMIT }
    )

    const receipt = await transaction.wait()
  }

  console.log(`Trade Complete:\n`)

  // Fetch token balances after
  const tokenBalanceAfter = await _token0Contract.balanceOf(account.address)
  const ethBalanceAfter = await provider.getBalance(account.address)

  const tokenBalanceDifference = tokenBalanceAfter - tokenBalanceBefore
  const ethBalanceDifference = ethBalanceBefore - ethBalanceAfter

  const data = {
    'ETH Balance Before': ethers.formatUnits(ethBalanceBefore, 'ether'),
    'ETH Balance After': ethers.formatUnits(ethBalanceAfter, 'ether'),
    'ETH Spent (gas)': ethers.formatUnits(ethBalanceDifference.toString(), 'ether'),
    '-': {},
    'WETH Balance BEFORE': ethers.formatUnits(tokenBalanceBefore, 'ether'),
    'WETH Balance AFTER': ethers.formatUnits(tokenBalanceAfter, 'ether'),
    'WETH Gained/Lost': ethers.formatUnits(tokenBalanceDifference.toString(), 'ether'),
    '-': {},
    'Total Gained/Lost': `${ethers.formatUnits((tokenBalanceDifference - ethBalanceDifference).toString(), 'ether')} ETH`
  }

  console.table(data)
}

main()