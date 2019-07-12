import {Instruction} from '../parse/instruction'
import {CompilationContext} from './context'
import {
	ALWAYS_BRANCHES,
	BranchResult,
	compileBlockInstruction,
	compileBranchInstruction,
	compileBranchTableInstruction,
	compileCallInstruction,
	compileIfInstruction,
	NEVER_BRANCHES,
	UNREACHABLE_INSTRUCTIONS
} from './control'
import {compileDropInstruction, compileSelectInstruction} from './drop-select'
import {compileReturn} from './helpers'
import {
	compileGrowInstruction,
	compileLoadInstruction,
	compileSizeInstruction,
	compileStoreInstruction
} from './memory'
import {
	compileBitCountInstruction,
	compileCompareInstruction,
	compileConstInstruction,
	compileConvertInstruction,
	compileExtendInstruction,
	compileFConvertInstruction,
	compileFloatBinaryInstruction,
	compileFloatUnaryInstruction,
	compileIntArithmeticInstruction,
	compileIntDivInstruction,
	compileIntMulInstruction,
	compileReinterpretInstruction,
	compileSignInstruction,
	compileTruncateInstruction,
	compileWrapInstruction
} from './numeric'
import {
	compileGetGlobalInstruction,
	compileGetLocalInstruction,
	compileSetGlobalInstruction,
	compileStoreLocalInstruction
} from './variable'
import {AssemblyInstruction} from './x86_64-asm'

function compileInstruction(
	instruction: Instruction,
	context: CompilationContext,
	output: AssemblyInstruction[]
): BranchResult {
	// Uncomment these lines to show the wasm instruction
	// corresponding to each assembly instruction
	// output.push(new asm.Comment(
	// 	JSON.stringify(instruction, (_, v) => typeof v === 'bigint' ? String(v) : v)
	// ))
	switch (instruction.type) {
		case 'unreachable':
			output.push(...UNREACHABLE_INSTRUCTIONS)
			return ALWAYS_BRANCHES
		case 'nop':
		case 'i64.extend_u': // 32-bit values are already stored with upper bits zeroed
			break
		case 'block':
		case 'loop':
			return compileBlockInstruction(instruction, context, output)
		case 'if':
			return compileIfInstruction(instruction, context, output)
		case 'br':
		case 'br_if':
			return compileBranchInstruction(instruction, context, output)
		case 'br_table':
			return compileBranchTableInstruction(instruction, context, output)
		case 'call':
		case 'call_indirect':
			compileCallInstruction(instruction, context, output)
			break
		case 'return':
			compileReturn(context, output)
			return ALWAYS_BRANCHES
		case 'drop':
			compileDropInstruction(context, output)
			break
		case 'select':
			compileSelectInstruction(context, output)
			break
		case 'get_local':
			compileGetLocalInstruction(instruction.local, context, output)
			break
		case 'set_local':
		case 'tee_local':
			compileStoreLocalInstruction(instruction, context, output)
			break
		case 'get_global':
			compileGetGlobalInstruction(instruction.global, context, output)
			break
		case 'set_global':
			compileSetGlobalInstruction(instruction.global, context, output)
			break
		case 'i32.load':
		case 'i64.load':
		case 'f32.load':
		case 'f64.load':
		case 'i32.load8_s':
		case 'i32.load8_u':
		case 'i32.load16_s':
		case 'i32.load16_u':
		case 'i64.load8_s':
		case 'i64.load8_u':
		case 'i64.load16_s':
		case 'i64.load16_u':
		case 'i64.load32_s':
		case 'i64.load32_u':
			compileLoadInstruction(instruction, context, output)
			break
		case 'i32.store':
		case 'i64.store':
		case 'f32.store':
		case 'f64.store':
		case 'i32.store8':
		case 'i32.store16':
		case 'i64.store8':
		case 'i64.store16':
		case 'i64.store32':
			compileStoreInstruction(instruction, context, output)
			break
		case 'memory.size':
			compileSizeInstruction(context, output)
			break
		case 'memory.grow':
			compileGrowInstruction(context, output)
			break
		case 'i32.const':
		case 'i64.const':
		case 'f32.const':
		case 'f64.const':
			compileConstInstruction(instruction, context, output)
			break
		case 'i32.eqz':
		case 'i32.eq':
		case 'i32.ne':
		case 'i32.lt_s':
		case 'i32.lt_u':
		case 'i32.le_s':
		case 'i32.le_u':
		case 'i32.gt_s':
		case 'i32.gt_u':
		case 'i32.ge_s':
		case 'i32.ge_u':
		case 'i64.eqz':
		case 'i64.eq':
		case 'i64.ne':
		case 'i64.lt_s':
		case 'i64.lt_u':
		case 'i64.le_s':
		case 'i64.le_u':
		case 'i64.gt_s':
		case 'i64.gt_u':
		case 'i64.ge_s':
		case 'i64.ge_u':
		case 'f32.eq':
		case 'f32.ne':
		case 'f32.lt':
		case 'f32.gt':
		case 'f32.le':
		case 'f32.ge':
		case 'f64.eq':
		case 'f64.ne':
		case 'f64.lt':
		case 'f64.gt':
		case 'f64.le':
		case 'f64.ge':
			compileCompareInstruction(instruction.type, context, output)
			break
		case 'i32.clz':
		case 'i32.ctz':
		case 'i32.popcnt':
		case 'i64.clz':
		case 'i64.ctz':
		case 'i64.popcnt':
			compileBitCountInstruction(instruction.type, context, output)
			break
		case 'i32.add':
		case 'i32.sub':
		case 'i32.and':
		case 'i32.or':
		case 'i32.xor':
		case 'i32.shl':
		case 'i32.shr_s':
		case 'i32.shr_u':
		case 'i32.rotl':
		case 'i32.rotr':
		case 'i64.add':
		case 'i64.sub':
		case 'i64.and':
		case 'i64.or':
		case 'i64.xor':
		case 'i64.shl':
		case 'i64.shr_s':
		case 'i64.shr_u':
		case 'i64.rotl':
		case 'i64.rotr':
			compileIntArithmeticInstruction(instruction.type, context, output)
			break
		case 'i32.mul':
		case 'i64.mul':
			compileIntMulInstruction(instruction.type, context, output)
			break
		case 'i32.div_s':
		case 'i32.div_u':
		case 'i32.rem_s':
		case 'i32.rem_u':
		case 'i64.div_s':
		case 'i64.div_u':
		case 'i64.rem_s':
		case 'i64.rem_u':
			compileIntDivInstruction(instruction.type, context, output)
			break
		case 'f32.abs':
		case 'f32.neg':
		case 'f32.copysign':
		case 'f64.abs':
		case 'f64.neg':
		case 'f64.copysign':
			compileSignInstruction(instruction.type, context, output)
			break
		case 'f32.ceil':
		case 'f32.floor':
		case 'f32.trunc':
		case 'f32.nearest':
		case 'f32.sqrt':
		case 'f64.ceil':
		case 'f64.floor':
		case 'f64.trunc':
		case 'f64.nearest':
		case 'f64.sqrt':
			compileFloatUnaryInstruction(instruction.type, context, output)
			break
		case 'f32.add':
		case 'f32.sub':
		case 'f32.mul':
		case 'f32.div':
		case 'f32.min':
		case 'f32.max':
		case 'f64.add':
		case 'f64.sub':
		case 'f64.mul':
		case 'f64.div':
		case 'f64.min':
		case 'f64.max':
			compileFloatBinaryInstruction(instruction.type, context, output)
			break
		case 'i32.wrap':
			compileWrapInstruction(context, output)
			break
		case 'i32.trunc_s/f32':
		case 'i32.trunc_u/f32':
		case 'i32.trunc_s/f64':
		case 'i32.trunc_u/f64':
		case 'i64.trunc_s/f32':
		case 'i64.trunc_u/f32':
		case 'i64.trunc_s/f64':
		case 'i64.trunc_u/f64':
			compileTruncateInstruction(instruction.type, context, output)
			break
		case 'i64.extend_s':
			compileExtendInstruction(context, output)
			break
		case 'f32.convert_s/i32':
		case 'f32.convert_u/i32':
		case 'f32.convert_s/i64':
		case 'f32.convert_u/i64':
		case 'f64.convert_s/i32':
		case 'f64.convert_u/i32':
		case 'f64.convert_s/i64':
		case 'f64.convert_u/i64':
			compileConvertInstruction(instruction.type, context, output)
			break
		case 'f32.demote':
		case 'f64.promote':
			compileFConvertInstruction(instruction.type, context, output)
			break
		case 'i32.reinterpret':
		case 'i64.reinterpret':
		case 'f32.reinterpret':
		case 'f64.reinterpret':
			compileReinterpretInstruction(instruction.type, context, output)
			break
		default:
			const unreachable: never = instruction
			unreachable
	}
	return NEVER_BRANCHES
}
export function compileInstructions(
	instructions: Instruction[],
	context: CompilationContext,
	output: AssemblyInstruction[]
): BranchResult {
	const allBranches = new Set<string>()
	for (const instruction of instructions) {
		const {branches, definitely} = compileInstruction(instruction, context, output)
		for (const label of branches) allBranches.add(label)
		if (definitely) return {branches: allBranches, definitely}
	}
	return {branches: allBranches, definitely: false}
}