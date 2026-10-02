// Copy the pinned original schema's public option lists, never personal data.
import fs from 'node:fs/promises';
import ts from 'typescript';
import vm from 'node:vm';
const source=await fs.readFile(new URL('../../../../extensions/speedyapply-local/src/chunks/globals-BVF4Hukb.js',import.meta.url),'utf8');
const ast=ts.createSourceFile('original.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const names={JE:'degrees',YE:'languages',XE:'proficiencies',eD:'genders',tD:'ethnicities',nD:'countries'},result={};
for(const statement of ast.statements)if(ts.isVariableStatement(statement))for(const declaration of statement.declarationList.declarations){const name=declaration.name.getText(ast);if(names[name])result[names[name]]=vm.runInNewContext(declaration.initializer.getText(ast),{}, {timeout:1000});}
if(Object.keys(result).length!==6)throw Error('Original profile option schema changed');
await fs.writeFile(new URL('../src/manage/profile-options.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
