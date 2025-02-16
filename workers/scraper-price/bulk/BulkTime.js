const mongoose = require('mongoose');

const TokenBasic = require('../../../server/models/token_basic');
const TokenHistory = require('../../../server/models/token_history');
const HistoryPrice = require('../../../server/models/history_prices');
const HistoryTransaction = require('../../../server/models/history_transactions');
const EnumBulkTypes = require('../../../enum/bulk.records.type');

let modelsMapping = {
    [EnumBulkTypes.TOKEN_HISTORY]: TokenHistory,
    [EnumBulkTypes.HISTORY_PRICE]: HistoryPrice,
    [EnumBulkTypes.HISOTRY_TRANSACTION]: HistoryTransaction
}

/**
 * Manage bulk operations on objects that have strong time connection
 */
class BulkTime {
    constructor( cache ) {
        this.BulkWriteOperations = {
            tokenHistory: {},
            historyPrice: {},
            historyTransacton: {}
        } 
        this.cache = cache;
    }
    getHistories(type){
        return this.BulkWriteOperations[type];
    }
    getHistory( pair, type ){
        return this.BulkWriteOperations[type][pair];
    }
    intializeBulkForContract( pair, type, time ){
        if(!this.BulkWriteOperations[type][pair]) this.BulkWriteOperations[type][pair] = {};
        if(!this.BulkWriteOperations[type][pair][time]) this.BulkWriteOperations[type][pair][time] = {};
            
    }
    intializeBulkUpdate( pair, type, time ){
        this.intializeBulkForContract( pair, type, time );
        if(!this.BulkWriteOperations[type][pair][time].update) {
            console.log(`[BULK ADD UPDATE ${type}] ${Object.keys(this.BulkWriteOperations[type]).length} ${pair}`);
            this.BulkWriteOperations[type][pair][time].update = {
                updateOne: {
                    filter: { pair: pair, time: time },
                    update: { 
                        $push: { }, 
                        $inc: { },
                        $set: { },
                    }
                }
            };
        }
    }
   
    /**
     * @description Add inside the bulk operations an insert 
     * @param {*} pair address
     * @param {*} historyToInsert object
     */
    setNewDocument( pair, type, time, record  ){
        this.intializeBulkForContract( pair, type, time );
        this.BulkWriteOperations[type][pair][time].insert = record;

        // update the price inside the cache instead of reading from the db
        if( type == EnumBulkTypes.HISTORY_PRICE ) {
            this.cache.setHistoryPrice(pair, record);
        }
            
    }
    setTokenBulkInc( pair, type, time, path, amoutToInc ){
        this.intializeBulkForContract( pair, type, time );
        this.intializeBulkUpdate( pair, type, time );
        
        if( this.BulkWriteOperations[type][pair][time].insert ) { // if there is already a document that will be inserted with the passed time update this, instead of doing more operations on the db
            this.BulkWriteOperations[type][pair][time].insert[path] += amoutToInc;
        } else { // create a new operation to execute on the db
            let incObj = this.BulkWriteOperations[type][pair][time].update.updateOne.update['$inc'];
            if( !incObj[path] ) incObj[path] = 0;
            incObj[path] += amoutToInc;
        }

        // update the price inside the cache instead of reading back from the db
        if( type == EnumBulkTypes.HISTORY_PRICE ){
            let cached = this.cache.getHistoryPrice(pair);
            if(!cached) return;
            cached[path] += amoutToInc;
        } 
    }
    setTokenBulkSet( pair, type, time, path, toSet ){
        this.intializeBulkForContract( pair, type, time );
        this.intializeBulkUpdate( pair, type, time );

        if( this.BulkWriteOperations[type][pair][time].insert ) { // if there is already a document that will be inserted with the passed time update this, instead of doing more operations on the db
            this.BulkWriteOperations[type][pair][time].insert[path] = toSet;
        } else { // create a new operation to execute on the db
            let setObj = this.BulkWriteOperations[type][pair][time].update.updateOne.update['$set'];
            setObj[path] = toSet;
        }

        // update the price inside the cache instead of reading back from the db
        if( type == EnumBulkTypes.HISTORY_PRICE ){
            let cached = this.cache.getHistoryPrice(pair);
            if(!cached) return;
            cached[path] = toSet;
        }
    }

    async execute(){
        let updatedContracts = [];
        for( let typeKey in EnumBulkTypes ){
            let type = EnumBulkTypes[typeKey];
            updatedContracts = [ ...( await this.executeUtil( type, modelsMapping[type] ) ), ...updatedContracts ];
        }
        return updatedContracts;
    }

    async executeUtil( type, model ){

        if(!type || !model) console.log(`[ERROR EXECUTING BUL UPDATES] `, type, model );

        let toExecuteInsert = [];
        let toExecutePush = [];
        let toExecuteSet = [];
        
        let tokenContracts = Object.keys(this.BulkWriteOperations[type]); // get contracts to update
        let BulkWriteOperationsClone = JSON.parse(JSON.stringify(this.BulkWriteOperations[type]));
        
        // reset bulk object
        delete this.BulkWriteOperations[type];
        this.BulkWriteOperations[type]= {};

        for( let contract of tokenContracts ){ // populate (insert, push and set) arrays
            let bulkOperations = BulkWriteOperationsClone[contract];
            for( let time in bulkOperations ){
                let toInsert = BulkWriteOperationsClone[contract][time].insert;
                if(toInsert) toExecuteInsert.push(toInsert);
                let toUpdate = BulkWriteOperationsClone[contract][time].update;

                if(toUpdate) {

                    // clear empty update fields
                    if( !Object.keys(toUpdate.updateOne.update['$set']).length ) delete toUpdate.updateOne.update['$set'];
                    if( !Object.keys(toUpdate.updateOne.update['$inc']).length ) delete toUpdate.updateOne.update['$inc'];
                    if( !Object.keys(toUpdate.updateOne.update['$push']).length ) delete toUpdate.updateOne.update['$push'];

                    let clonedPush = JSON.parse(JSON.stringify(toUpdate));
                    let clonedSet = JSON.parse(JSON.stringify(toUpdate));

                    if( clonedPush.updateOne.update['$push'] ){
                        delete clonedPush.updateOne.update['$set'];
                        delete clonedPush.updateOne.update['$inc'];
                        toExecutePush.push( clonedPush );
                    }

                    if( clonedPush.updateOne.update['$inc'] || clonedPush.updateOne.update['$set']  ){
                        delete clonedSet.updateOne.update['$push'];
                        toExecuteSet.push( clonedSet );
                    }
                    
                }
            }
            
        }

        console.log( type, "toExecuteInsert: ", JSON.stringify(toExecuteInsert));
        console.log( type, "\n\ntoExecutePush: ", JSON.stringify(toExecutePush));
        console.log( type, "\n\ntoExecuteSet: ", JSON.stringify(toExecuteSet));
       
        await model.insertMany(toExecuteInsert);
        console.log("EXECUTED INSERT");
        await model.bulkWrite(toExecutePush);
        console.log("EXECUTED PUSH");
        await model.bulkWrite(toExecuteSet);
        console.log("EXECUTED SET");
        return tokenContracts;
    }
}

module.exports = BulkTime;