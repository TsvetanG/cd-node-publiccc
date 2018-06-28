/*
Copyright Chaindigit.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

		 http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
// DO NOT USE IN PRODUCTION

const shim = require('fabric-shim');
const ClientIdentity = require('fabric-shim').ClientIdentity;

//Used to log
var logger = shim.newLogger('publiccc');
// The log level can be set by 'CORE_CHAINCODE_LOGGING_SHIM' to CRITICAL, ERROR, WARNING, DEBUG
logger.level = 'debug';

var Chaincode = class {
	async Init(stub) {
		logger.info('ChainCode Initialize');
		return shim.success();
	}

	async Invoke(stub) {
		logger.info('ChainCode Invoke');
		let fap = stub.getFunctionAndParameters();
		let func = fap.fcn;
		let args = fap.params;

		logger.info('Invoke function' + func);

		if (func === 'query') {
			return await this.query(stub, args);
		}

		if (func === 'pushClientData') {
			return await this.pushClientData(stub, args);
		}

		logger.Errorf(`Unknown action: ${func}`);
		return shim.error(`Unknown action: ${func}`);
	}

	async pushClientData(stub, args) {
		logger.info("Record client data -> public and private parts");

		logger.info("Number of parameters: " + args.length);

		if (args.length != 2) {
			return shim.error('Expecting client ID and file id');
		}
		
		let clientId = args[0];
		let fileId = args[1];
		
		//Make sure the caller (user initiating the transaction) has the client consent
		let callerIdentity = new ClientIdentity(stub);
		let mspId = callerIdentity.getMSPID();
		
		logger.info(`Caller MSP ID = ${mspId}`);

		logger.info(`Caller ID = ${callerIdentity.getID()}`); 

		let hasConsent = await this.isConsentGiven(stub, clientId);

		if(hasConsent != true) return shim.error(`Consent not given for client: ${clientId} and MSP: ${mspId}`);
		
		//The public data and private data is passed in a transient map 
		//The public data is recorded by the public chaincode on the channel ledger
		//The private data is recorded on the private collection using private chaincode
	
		let transMap = stub.getTransient();

		let publicData = transMap.get('public');
		let privateData = transMap.get('private'); 
		
		//Record the private data calling the private chaincode
		let chaincodeName = "privatecc" + mspId;
		
		logger.info(`Calling private data store chaincode: ${chaincodeName}`);
		let channel = '';
		let result = await stub.invokeChaincode( chaincodeName, [ Buffer.from('push'), Buffer.from(clientId) , Buffer.from(fileId) , Buffer.from(privateData.toString('utf8')) ], channel );
		
		logger.info(`Private data push result: ${result}`);
		
		//Store the public data
		
		//let value = [ clientId, callerIdentity.getMSPID() ];
		let value = [ clientId, fileId ];
		let compKey = stub.createCompositeKey("clid~fileid", value );
		
		logger.info("Add public data: " + publicData.toString('utf8') );
		
		//Record the public data
		await stub.putState(compKey,publicData);
		
		//Add composite key for search
		value = [ clientId, callerIdentity.getMSPID(), fileId ];
		compKey = stub.createCompositeKey("clid~mspid~fileid", value );
		await stub.putState(compKey, Buffer.from("X"));
		
		value = [ clientId, fileId, callerIdentity.getMSPID() ];
		compKey = stub.createCompositeKey("clid~fileid~mspid", value );
		await stub.putState(compKey, Buffer.from("X"));

		return shim.success(Buffer.from('Data recorded'));
	}
	
	async isConsentGiven(stub, clientId) {
		logger.info(`Check consent for client id ${clientId}`);
		let callerIdentity = new ClientIdentity(stub);
		let mspId = callerIdentity.getMSPID();
		
		logger.info(`Caller MSP ID = ${mspId}`);
		logger.info(`Caller ID = ${callerIdentity.getID()}`); 
	 	
		logger.info(`Query consent for client with id: ${clientId}` );
		let channel = '';
		//Call the consent chaincode on the same public channel
		let result = await stub.invokeChaincode('consentcc', [ Buffer.from('query') , Buffer.from(clientId) , Buffer.from(mspId) ] , channel);
		
		let qResp = result.payload.toString('utf8');
		
		logger.info(`Consent query response : ${qResp}` );
		
		let consent = JSON.parse(qResp);
		
		logger.info(`Consent for client: ${consent}` );
		
		logger.info(`Consent for clientID : ${consent.ClientID}` );
		
		if(consent.ClientID !== clientId) {
			logger.info(`Consent not recorded for client: ${clientId}`);
			return false;
		}
		
		let hasConsent = false;
		
		let consentMsp = mspId + ":X";
		
		for (let item in consent.Consents) {
			logger.info(`Check consent loop item: ${consent.Consents[item]}` );
			if(consent.Consents[item] === consentMsp) hasConsent = true;
		}
		
		return hasConsent;
	}

	async query(stub, args) {

		logger.info("Query Number of parameters: " + args.length);
		if (args.length != 2) {
			return shim.error('Expecting client ID and query operation as input');
		}
		let clientID = args[0];
		let ops = args[1];
		
		logger.info("Query consent for client: " + clientID);
		
		let hasConsent = await this.isConsentGiven(stub, clientID);
		
		//Consent may be based as well on user not just MSP
		if(hasConsent != true) return shim.error(`No Consent given`);
	 	
		let iterator = await stub.getStateByPartialCompositeKey("clid~fileid", [ clientID ] );
		
		let allResults = [];
		
		while (true) {
			let res = await iterator.next();
			logger.info('Iterator result: ' + res);
			let keys = stub.splitCompositeKey(res.value.key);
			let fileId = keys.attributes[1];
			let publicData = res.value.value.toString('utf8');
			//fetch the private data from the private collection chaincode
			let privateData = await this.fetchPrivateData(stub, clientID, fileId);
			let data = { file: fileId , pubData: publicData, prvData: privateData };
			logger.info(`File: ${data}`);
			logger.info(`File id: ${fileId}`);
			allResults.push(data);
			
			if (res.done) {
				logger.info('End of data set');
				await iterator.close(); 
				logger.info('Iterator closed');
				break;
			}
	    }
		
		let jsonResp = {
			ClientID: clientID,
			Files: allResults
		};
		

		logger.info('Response to query:%s\n', JSON.stringify(jsonResp));

		return shim.success(Buffer.from(JSON.stringify(jsonResp)));
	}
	
	async fetchPrivateData(stub, clientID, fileID) {
		let callerIdentity = new ClientIdentity(stub);
		let mspId = callerIdentity.getMSPID();
		let chaincodeName = "privatecc" + mspId;
		let channel = '';
	    let query = await stub.invokeChaincode( chaincodeName, [ Buffer.from('query'), Buffer.from(clientID) , Buffer.from(fileID) ], channel );
	    logger.info("Data received: " + query);
	    logger.info("Data message: " + query.message);
	    logger.info("Data payload: " + query.payload.toString('utf8'));
	    return query.payload.toString('utf8');
		
	}

};

//start the chaincode process
shim.start(new Chaincode());